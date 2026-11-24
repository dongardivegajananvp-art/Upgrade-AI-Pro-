import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const FORMAT = 'UPGRADE_AI_PRO_FYERS_EXPIRED_OPTION_DATA_V1';
const CORE_COLUMNS = ['timestamp','open','high','low','close','volume'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function istDate(epochMs) {
  return new Date(Number(epochMs) + 19800000).toISOString().slice(0,10);
}
function parseDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new Error('Dates must use YYYY-MM-DD');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw new Error('Invalid calendar date');
  return time;
}
function assertNseQuietWindow(epochMs) {
  const ist = new Date(Number(epochMs) + 19800000);
  const day = ist.getUTCDay();
  const minute = ist.getUTCHours()*60 + ist.getUTCMinutes();
  if (day >= 1 && day <= 5 && minute >= 525 && minute < 960) {
    throw new Error('LIVE_SESSION_PROTECTION: expired-option research paused during NSE weekday quiet window (08:45-16:00 IST)');
  }
}
function optionStrike(symbol) {
  if (typeof symbol !== 'string' || !/^NSE:[A-Z0-9&._-]+(?:CE|PE)$/.test(symbol)) return null;
  const match = symbol.match(/(\d+(?:\.\d+)?)(?:CE|PE)$/);
  if (!match) return null;
  const strike = Number(match[1]);
  return Number.isFinite(strike) && strike > 0 ? strike : null;
}
function verifyResponse(response, label) {
  if (!response || response.s !== 'ok' || !response.data || typeof response.data !== 'object') {
    throw new Error('FYERS expired '+label+' unavailable: '+String(response?.message || response?.s || 'invalid response').slice(0,160));
  }
  return response.data;
}
function normalizeCandles(response, {symbol, expiry, start, end}) {
  if (!response || !['ok','no_data'].includes(response.s) || response.symbol !== symbol || response.resolution !== '5') {
    throw new Error('FYERS expired option candle response identity/resolution is invalid');
  }
  if (!Array.isArray(response.columns) || response.columns.length < 6 ||
      CORE_COLUMNS.some((name,index)=>response.columns[index]!==name) ||
      new Set(response.columns).size !== response.columns.length) {
    throw new Error('FYERS expired option candle columns are invalid');
  }
  if (!Array.isArray(response.candles)) throw new Error('FYERS expired option candle rows are missing');
  if (response.s === 'no_data') {
    if (response.candles.length) throw new Error('FYERS no_data response unexpectedly contains candles');
    return [];
  }
  const seen = new Set();
  const rows = [];
  for (const row of response.candles) {
    if (!Array.isArray(row) || row.length !== response.columns.length) throw new Error('FYERS expired option candle row shape is invalid');
    const [time,open,high,low,close,volume] = row.slice(0,6).map(Number);
    const date = istDate(time*1000);
    const minuteDate = new Date((time+19800)*1000);
    const minute = minuteDate.getUTCHours()*60+minuteDate.getUTCMinutes();
    if (![time,open,high,low,close,volume].every(Number.isFinite) || time<=0 ||
        date<start || date>end || date>expiry || minute<555 || minute>=930 ||
        open<=0 || close<=0 || high<Math.max(open,close,low) || low>Math.min(open,close) ||
        volume<0 || seen.has(time)) {
      throw new Error('FYERS expired option candle is malformed, out of range or duplicated');
    }
    seen.add(time);
    rows.push({time,open,high,low,close,volume,completed:true,source:'FYERS_EXPIRED_FO_5M'});
  }
  rows.sort((a,b)=>a.time-b.time);
  if (rows.some((row,index)=>index>0 && row.time<=rows[index-1].time)) throw new Error('FYERS expired option candles are not strictly ordered');
  return rows;
}
async function writeOnce(file, value) {
  const bytes = Buffer.from(JSON.stringify(value,null,2)+'\n');
  try {
    const existing = await readFile(file);
    if (!existing.equals(bytes)) throw new Error('HISTORICAL_ARCHIVE_CONFLICT: refusing to overwrite different source evidence');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = file+'.tmp';
  await writeFile(temp,bytes,{flag:'wx'});
  await rename(temp,file);
}

const DAILY_BUDGET_FORMAT = 'FYERS_EXPIRED_OPTION_DAILY_BUDGET_V1';
const DAILY_REQUEST_LIMIT = 10;

/**
 * Reserve one provider request atomically in a persistent IST-day ledger.
 * Reservations are never refunded after a network error: conservative counting
 * prevents retries or parallel invocations from exceeding the daily allowance.
 */
async function reserveDailyRequest(budgetDir, now) {
  const day = istDate(now);
  const file = path.join(budgetDir, 'fyers-expired-option-budget-' + day + '.json');
  const lock = file + '.lock';
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lock);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(50);
    }
  }
  if (!acquired) throw new Error('FYERS expired-option daily budget lock is busy; request blocked safely');
  try {
    let used = 0;
    try {
      const prior = JSON.parse((await readFile(file, 'utf8')));
      if (prior.format !== DAILY_BUDGET_FORMAT || prior.istDate !== day ||
          prior.limit !== DAILY_REQUEST_LIMIT || !Number.isInteger(prior.used) ||
          prior.used < 0 || prior.used > DAILY_REQUEST_LIMIT) {
        throw new Error('FYERS expired-option daily budget ledger is invalid; request blocked safely');
      }
      used = prior.used;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (used >= DAILY_REQUEST_LIMIT) {
      throw new Error('FYERS Standard expired-F&O daily request budget exhausted; no upstream request was sent');
    }
    const next = {
      format: DAILY_BUDGET_FORMAT,
      istDate: day,
      limit: DAILY_REQUEST_LIMIT,
      used: used + 1,
      updatedAt: new Date(now).toISOString()
    };
    const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
    await rename(temporary, file);
    return { used: next.used, remaining: DAILY_REQUEST_LIMIT - next.used, ledgerFile: file };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Read-only expired-option archive. The client is an adapter around the
 * documented FYERS methods: expiry_dates, history_underlying_symbols and
 * fno_historical_data. No live app, REST governor, scanner or order imports.
 *
 * ATM is selected from the completed underlying close supplied by the caller
 * and the provider-returned expired strike list. It is not a modern option-chain
 * snapshot and does not imply historical bid/ask availability.
 */
export async function exportExpiredOptionPair({
  client, underlying, expiry, start, end, underlyingPrice, selectionTime,
  outputDir, budgetDir, now=Date.now(), clock=()=>Date.now(), pause=sleep,
  minRequestGapMs=4000, maxIntradayRequests=10
}={}) {
  if (!client || typeof client.expiry_dates!=='function' ||
      typeof client.history_underlying_symbols!=='function' ||
      typeof client.fno_historical_data!=='function') {
    throw new Error('A FYERS client adapter with expiry_dates, history_underlying_symbols and fno_historical_data is required');
  }
  if (typeof underlying!=='string' || !/^NSE:[A-Z0-9&._-]+(?:-EQ|-INDEX)$/.test(underlying)) throw new Error('A verified NSE equity/index underlying is required');
  const expiryMs=parseDate(expiry), startMs=parseDate(start), endMs=parseDate(end);
  if (!(startMs<=endMs && endMs<=expiryMs && expiryMs<Date.parse(istDate(now)+'T00:00:00Z'))) throw new Error('Expired option research range must be historical and end on/before expiry');
  if (start !== end) throw new Error('Historical ATM option export must be scoped to one trading date so a single underlying close cannot mislabel contracts across sessions');
  if ((endMs-startMs)/86400000>99) throw new Error('Expired F&O 5-minute request may cover at most 100 calendar dates');
  if (!Number.isFinite(Number(underlyingPrice)) || Number(underlyingPrice)<=0 ||
      !Number.isFinite(Number(selectionTime)) || Number(selectionTime)<=0) throw new Error('A positive completed historical underlying close and its timestamp are required');
  const selectionDate=istDate(Number(selectionTime)*1000);
  const selectionClock=new Date((Number(selectionTime)+19800)*1000);
  const selectionMinute=selectionClock.getUTCHours()*60+selectionClock.getUTCMinutes();
  if (selectionDate!==start || selectionMinute<560 || selectionMinute>930) throw new Error('Historical underlying close timestamp must be a completed NSE 5-minute candle close within the selected trading date');
  if (!outputDir || !Number.isInteger(minRequestGapMs) || minRequestGapMs<1000 || minRequestGapMs>60000 ||
      !Number.isInteger(maxIntradayRequests) || maxIntradayRequests<4 || maxIntradayRequests>10) {
    throw new Error('Output directory, safe request pacing and Standard-plan 4-to-10 request budget are required');
  }
  if (!budgetDir) throw new Error('A persistent budgetDir is required for the cross-invocation daily request ledger');
  const budgetRoot=path.resolve(budgetDir);
  await mkdir(budgetRoot,{recursive:true});
  const requestLog=[];
  let lastRequestAt=0;
  let dailyBudget=null;
  const invoke=async (label, fn) => {
    assertNseQuietWindow(clock());
    const wait=Math.max(0,lastRequestAt+minRequestGapMs-Date.now());
    if (wait) await pause(wait);
    assertNseQuietWindow(clock());
    if (requestLog.length>=maxIntradayRequests) throw new Error('Per-invocation FYERS expired-option request budget exhausted');
    dailyBudget=await reserveDailyRequest(budgetRoot,clock());
    lastRequestAt=Date.now();
    const response=await fn();
    requestLog.push({label,completedAt:new Date(clock()).toISOString(),responseSha256:sha256(JSON.stringify(response))});
    return response;
  };

  const expiryResponse=await invoke('expiry_dates',()=>client.expiry_dates({
    symbol:underlying,range_from:start,range_to:end,date_format:'1'
  }));
  const expiryData=verifyResponse(expiryResponse,'expiry-date catalog');
  const optionExpiries=expiryData.expiry_dates?.options;
  if (!Array.isArray(optionExpiries) || !optionExpiries.includes(expiry)) throw new Error('Requested expiry is not present in FYERS historical option expiry catalog');

  const contractsResponse=await invoke('history_underlying_symbols',()=>client.history_underlying_symbols({
    symbol:underlying,expiry_date:expiry
  }));
  const contractsData=verifyResponse(contractsResponse,'contract catalog');
  if (contractsData.expiry_date!==expiry || !Array.isArray(contractsData.contracts?.options)) throw new Error('FYERS expired option contract catalog identity is invalid');
  const listed=contractsData.contracts.options.filter(symbol=>typeof symbol==='string' && /^NSE:[A-Z0-9&._-]+(?:CE|PE)$/.test(symbol));
  const strikes=[...new Set(listed.map(optionStrike).filter(Number.isFinite))].sort((a,b)=>a-b);
  if (!strikes.length) throw new Error('FYERS expired option catalog contains no parseable option strikes');
  const strike=strikes.reduce((best,value)=>Math.abs(value-Number(underlyingPrice))<Math.abs(best-Number(underlyingPrice))?value:best,strikes[0]);
  const pair={};
  for (const side of ['CE','PE']) {
    const matches=listed.filter(symbol=>symbol.endsWith(String(strike)+side));
    if (matches.length!==1) throw new Error('FYERS exact ATM '+side+' contract is missing or ambiguous');
    pair[side]=matches[0];
  }
  if (pair.CE===pair.PE) throw new Error('FYERS expired CE/PE contract identity collision');

  const root=path.resolve(outputDir);
  await mkdir(root,{recursive:true});
  const contractResults={};
  for (const side of ['CE','PE']) {
    const symbol=pair[side];
    const response=await invoke('fno_historical_data_'+side,()=>client.fno_historical_data({
      symbol,resolution:'5',date_format:'1',range_from:start,range_to:end,
      include_oi:'0',include_greeks:'0'
    }));
    const candles=normalizeCandles(response,{symbol,expiry,start,end});
    const payload={
      format:FORMAT,source:'FYERS_EXPIRED_FO_API',symbol,underlying,expiry,strike,side,
      selection:{method:'NEAREST_LISTED_STRIKE_TO_COMPLETED_UNDERLYING_CLOSE',underlyingPrice:Number(underlyingPrice),selectionTime:Number(selectionTime),historicalAtmSelection:true},
      requested:{start,end,resolution:'5'},timestampConvention:'FYERS_EPOCH_BAR_START',
      columns:response.columns,candles,responseSha256:sha256(JSON.stringify(response)),
      candleSha256:sha256(JSON.stringify(candles)),retrievedAt:new Date(clock()).toISOString(),
      historicalBidAskDepthAvailable:false,actionable:false,ordersEnabled:false
    };
    const filename=symbol.replace(':','_')+'.json';
    await writeOnce(path.join(root,filename),payload);
    contractResults[side]={file:filename,status:candles.length?'EXPORTED':'NO_DATA',candleCount:candles.length};
  }
  const report={
    format:FORMAT,source:'FYERS_EXPIRED_FO_API',status:Object.values(contractResults).every(x=>x.status==='EXPORTED')?'PAIR_EXPORTED':'PARTIAL',
    underlying,expiry,strike,selectionTime:Number(selectionTime),selectionMethod:'NEAREST_LISTED_STRIKE_TO_COMPLETED_UNDERLYING_CLOSE',
    requested:{start,end,resolution:'5'},contracts:pair,contractResults,requestCount:requestLog.length,
    requestBudget:{maxIntradayRequests,used:dailyBudget?.used??0,remaining:dailyBudget?.remaining??DAILY_REQUEST_LIMIT,providerDailyLimit:DAILY_REQUEST_LIMIT,usedToday:dailyBudget?.used??0,remainingToday:dailyBudget?.remaining??DAILY_REQUEST_LIMIT,invocationLimit:maxIntradayRequests,usedThisInvocation:requestLog.length,ledgerFile:dailyBudget?.ledgerFile??null},
    requestEvidence:requestLog,actionable:false,ordersEnabled:false,liveStateTouched:false,
    limitations:[
      'Provider contract symbols and expiry are taken from FYERS expired-F&O discovery APIs.',
      'Strike selection uses the supplied completed underlying candle close; this is not a historical bid/ask or option-chain replay.',
      'FYERS expired-F&O API exposes candle OHLCV here; historical bid/ask depth and actual executable fills are not established.',
      'FYERS History API support confirms candle epoch timestamps mark the start of each interval; this is the convention used for replay alignment.',
      'This export is data collection only; it does not calculate strategy performance or P&L.'
    ]
  };
  await writeOnce(path.join(root,'collection-'+expiry+'-'+String(strike)+'.json'),report);
  return {report,outputDir:root};
}
