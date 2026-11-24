import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const DATA_URL = 'https://api-t1.fyers.in/data/history';
const MASTER_FORMAT = 'UPGRADE_AI_PRO_FYERS_NSE_FNO_MASTER_V1';
const DATA_FORMAT = 'UPGRADE_AI_PRO_FYERS_HISTORICAL_DATASET_V1';
const PROVENANCE = 'FYERS_HISTORICAL_API';
const MASTER_PROVENANCE = 'FYERS_OFFICIAL_SYMBOL_MASTER';
const SYMBOL = /^NSE:[A-Z0-9&._-]{1,48}-EQ$/;
const DAY = 86400;
const FIVE_MINUTES = 300;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function istDate(seconds) { return new Date((Number(seconds) + 19800) * 1000).toISOString().slice(0, 10); }
function normalizeFiveMinute(rows, start, end, nowSeconds) {
  if (!Array.isArray(rows)) throw new Error('FYERS 5-minute response did not contain a candles array');
  const seen = new Set();
  const candles = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error('Malformed FYERS 5-minute candle row');
    const [time,open,high,low,close,volume] = row.map(Number);
    const ist = new Date((time + 19800) * 1000);
    const minuteOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (![time,open,high,low,close,volume].every(Number.isFinite) || time < start || time > end || time + FIVE_MINUTES > nowSeconds || minuteOfDay < 555 || minuteOfDay > 925 || time <= 0 || open <= 0 || close <= 0 || high < Math.max(open,close,low) || low > Math.min(open,close) || volume < 0 || seen.has(time)) throw new Error('Invalid or duplicate FYERS 5-minute candle; refusing to repair or interpolate');
    seen.add(time);
    candles.push({time,open,high,low,close,volume,completed:true,source:'FYERS_HISTORY_5M'});
  }
  return candles.sort((a,b)=>a.time-b.time);
}
function normalizeDaily(rows, start, end, nowSeconds) {
  if (!Array.isArray(rows)) throw new Error('FYERS daily response did not contain a candles array');
  const todayStart = Math.floor((nowSeconds + 19800) / DAY) * DAY - 19800;
  const seen = new Set();
  const candles = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error('Malformed FYERS daily candle row');
    const [time,open,high,low,close,volume] = row.map(Number);
    if (![time,open,high,low,close,volume].every(Number.isFinite) || time < start || time > end || time >= todayStart || time > nowSeconds || time <= 0 || open <= 0 || close <= 0 || high < Math.max(open,close,low) || low > Math.min(open,close) || volume < 0 || seen.has(time)) throw new Error('Invalid, incomplete or duplicate FYERS daily candle');
    seen.add(time);
    candles.push({time,open,high,low,close,volume,completed:true,source:'FYERS_DAILY_HISTORY'});
  }
  return candles.sort((a,b)=>a.time-b.time);
}
function validateRange({startTime,dailyStartTime,endTime}) {
  const a=Number(startTime), d=Number(dailyStartTime), z=Number(endTime);
  if (![a,d,z].every(Number.isFinite) || d<=0 || a<=0 || z<=a || d>a) throw new Error('Historical date range is invalid');
  if ((z-a)/DAY>100 || (z-d)/DAY>366) throw new Error('Requested history range exceeds FYERS per-request limits');
}

async function atomicJson(file, value) {
  const temp=file+'.tmp';
  await writeFile(temp, JSON.stringify(value), {flag:'wx'});
  await rename(temp,file);
}

/**
 * Independent, sequential FYERS history exporter. Uses only an explicitly
 * supplied token and fetch implementation; it never imports the live app or
 * its REST governor. Keep this process outside the live workstation host.
 */
export async function exportFyersHistoricalDataset({
  masterFile, outputDir, appId, accessToken, fetchImpl=globalThis.fetch,
  now=Date.now(), minRequestGapMs=4000, pause=sleep
}={}) {
  if (!masterFile || !outputDir || !appId || !accessToken || typeof fetchImpl!=='function') throw new Error('Master file, output directory, FYERS app ID, access token and fetch implementation are required');
  if (!Number.isInteger(minRequestGapMs) || minRequestGapMs<1000 || minRequestGapMs>60000) throw new Error('Request pacing must be between 1000 and 60000 milliseconds');
  const output=path.resolve(outputDir);
  const masterPath=path.resolve(masterFile);
  const masterBytes=await readFile(masterPath);
  const master=JSON.parse(masterBytes.toString('utf8'));
  if (master.format!==MASTER_FORMAT || master.source!==MASTER_PROVENANCE || master.verifiedOfficialMaster!==true || !Array.isArray(master.symbols) || master.sourceFiles?.NSE_FO?.url!=='https://public.fyers.in/sym_details/NSE_FO_sym_master.json' || master.sourceFiles?.NSE_CM?.url!=='https://public.fyers.in/sym_details/NSE_CM_sym_master.json' || !/^[a-f0-9]{64}$/.test(master.sourceFiles?.NSE_FO?.sha256||'') || !/^[a-f0-9]{64}$/.test(master.sourceFiles?.NSE_CM?.sha256||'')) throw new Error('Input must be an explicitly verified FYERS official NSE F&O equity master export');
  for (const name of ['NSE_FO','NSE_CM']) {
    const source=master.sourceFiles[name];
    if (typeof source.file!=='string' || path.basename(source.file)!==source.file || !source.file.endsWith('_sym_master.json')) throw new Error('Official FYERS '+name+' raw master filename is missing or invalid');
    const raw=await readFile(path.join(path.dirname(masterPath),source.file));
    if (sha256(raw)!==source.sha256) throw new Error('Official FYERS '+name+' raw master SHA-256 mismatch');
  }
  const symbols=[...new Set(master.symbols.map(x=>String(x?.symbol||x).trim().toUpperCase()))].sort();
  if (!symbols.length || symbols.length>300 || symbols.some(s=>!SYMBOL.test(s))) throw new Error('Official master contains an empty, oversized or invalid NSE F&O equity universe');
  const endTime=Math.floor(now/1000);
  const startDate=new Date(now); startDate.setMonth(startDate.getMonth()-3);
  const startTime=Math.floor(startDate.getTime()/1000);
  const dailyStartTime=Math.floor((startDate.getTime()-120*86400000)/1000);
  const fiveMinuteStartTime=Math.floor((startDate.getTime()-5*86400000)/1000);
  validateRange({startTime:fiveMinuteStartTime,dailyStartTime,endTime});
  await mkdir(output,{recursive:true});
  const datasetMasterFiles={};
  for (const name of ['NSE_FO','NSE_CM']) {
    const source=master.sourceFiles[name];
    const bytes=await readFile(path.join(path.dirname(masterPath),source.file));
    const datasetFile='master-'+name+'_sym_master.json';
    if (sha256(bytes)!==source.sha256) throw new Error('Official FYERS '+name+' master changed during export');
    await writeFile(path.join(output,datasetFile+'.tmp'),bytes,{flag:'wx'});
    await rename(path.join(output,datasetFile+'.tmp'),path.join(output,datasetFile));
    datasetMasterFiles[name]={...source,datasetFile,sha256:sha256(bytes)};
  }
  const manifest={format:DATA_FORMAT,source:PROVENANCE,actionable:false,datasetId:'fyers-nse-fno-3m-'+endTime,createdAt:new Date(now).toISOString(),requested:{startTime,endTime,dailyStartTime,fiveMinuteStartTime},master:{sha256:sha256(masterBytes),retrievedAt:master.retrievedAt||null,source:MASTER_PROVENANCE,sourceFiles:datasetMasterFiles},requestPolicy:{sequential:true,minGapMs:minRequestGapMs,retries:0},files:[],failures:[]};
  let lastRequestAt=0;
  for (let index=0; index<symbols.length; index++) {
    const symbol=symbols[index];
    const fetchCandles=async (resolution,from) => {
      const wait=Math.max(0,lastRequestAt+minRequestGapMs-Date.now());
      if (wait) await pause(wait);
      const url=new URL(DATA_URL);
      url.searchParams.set('symbol',symbol);
      url.searchParams.set('resolution',resolution);
      url.searchParams.set('date_format','1');
      url.searchParams.set('range_from',istDate(from));
      url.searchParams.set('range_to',istDate(endTime));
      lastRequestAt=Date.now();
      const response=await fetchImpl(url,{method:'GET',headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
      const raw=await response.text();
      let body; try { body=JSON.parse(raw); } catch { throw new Error('FYERS returned non-JSON history response for '+symbol+' '+resolution); }
      if (response.status===429 || response.status===401 || response.status===403 || String(body.code??'').includes('1015') || /1015|too many requests|rate.?limit/i.test(String(body.message||''))) {
        const error=new Error('FYERS HTTP '+response.status+'; export stopped immediately without retry');
        error.stopExport=true; throw error;
      }
      if (!response.ok || body.s!=='ok' || !Array.isArray(body.candles)) throw new Error('FYERS history failed for '+symbol+' '+resolution+' (HTTP '+response.status+', code '+String(body.code??'n/a')+')');
      return {body,proof:{endpoint:'/data/history',resolution,rangeFrom:istDate(from),rangeTo:istDate(endTime),httpStatus:response.status,responseSha256:sha256(raw),retrievedAt:new Date().toISOString()}};
    };
    try {
      const five=await fetchCandles('5',fiveMinuteStartTime);
      const daily=await fetchCandles('D',dailyStartTime);
      const fiveMinuteCandles=normalizeFiveMinute(five.body.candles,fiveMinuteStartTime,endTime,Math.floor(now/1000));
      const dailyCandles=normalizeDaily(daily.body.candles,dailyStartTime,endTime,Math.floor(now/1000));
      if (!fiveMinuteCandles.length || dailyCandles.length<50) throw new Error('FYERS returned insufficient completed candles; no file accepted');
      const data={symbol,source:PROVENANCE,dataProvenance:PROVENANCE,fiveMinuteCandles,dailyCandles,topGainerMembership:[],requested:manifest.requested,retrievedAt:new Date().toISOString(),apiEvidence:{fiveMinute:five.proof,daily:daily.proof}};
      const bytes=Buffer.from(JSON.stringify(data));
      const filename=symbol.replace(/^NSE:/,'').replace(/-EQ$/,'').toLowerCase()+'.json';
      await atomicJson(path.join(output,filename),data);
      manifest.files.push({symbol,file:filename,sha256:sha256(bytes),fiveMinuteCount:fiveMinuteCandles.length,dailyCount:dailyCandles.length,apiEvidence:data.apiEvidence});
    } catch(error) {
      manifest.failures.push({symbol,reason:String(error?.message||error).slice(0,240)});
      if (error.stopExport) break;
    }
  }
  manifest.exportedCount=manifest.files.length;
  manifest.failureCount=manifest.failures.length;
  manifest.complete=manifest.exportedCount===symbols.length && manifest.failureCount===0;
  const manifestPath=path.join(output,'manifest.json');
  await atomicJson(manifestPath,manifest);
  return {manifestPath,manifest};
}

if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)) {
  const [masterFile,outputDir]=process.argv.slice(2);
  try {
    const result=await exportFyersHistoricalDataset({masterFile,outputDir,appId:process.env.FYERS_APP_ID?.trim(),accessToken:process.env.FYERS_ACCESS_TOKEN?.trim()});
    process.stdout.write(JSON.stringify({status:result.manifest.complete?'COMPLETE':'PARTIAL',manifestPath:result.manifestPath,exported:result.manifest.exportedCount,failed:result.manifest.failureCount,actionable:false,ordersEnabled:false})+'\n');
    if (!result.manifest.complete) process.exitCode=2;
  } catch(error) {
    process.stderr.write(JSON.stringify({status:'DATA_UNAVAILABLE',reason:String(error?.message||error).slice(0,240),actionable:false,ordersEnabled:false})+'\n');
    process.exitCode=1;
  }
}
