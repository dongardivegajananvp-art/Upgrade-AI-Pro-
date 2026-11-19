import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessFeed, tradingEnabled } from './src/safety.js';
import { createLoginUrl, verifyLoginState, exchangeAuthCode, getAuthStatus, createSessionCookie, restoreSessionCookie } from './src/fyers-auth.js';
import { startMarketSocket, getMarketData, getFnoUniverseSnapshot, setFnoUniverse, setSelectedOptionSymbol, setSelectedUnderlyingSymbol } from './src/fyers-market-socket.js';
import { loadFnoEquityUniverse, getVerifiedOptionContract } from './src/fyers-symbol-master.js';
import { chooseDirectionalOption } from './src/option-selection.js';
import { evaluateNineStrategies, detectNineStrategySetup } from './src/strategy-engine.js';
import { getFiveMinuteHistory, getFifteenMinuteHistory, getFyersQuotes, getFyersOptionChain, getFyersPositions, getFyersOrderbook, getRestDiagnostics, getDailyHistory, getCachedResearchHistories, validateNseSymbol } from './src/fyers-rest.js';
import { evaluateRollingFnoUniverse } from './src/rolling-fno-strategy-engine.js';
import { createResearchWarmupQueue } from './src/research-warmup-queue.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const EXPECTED_REDIRECT_URI = 'https://upgrade-ai-pro.onrender.com/api/fyers/auth/callback';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml' };

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 4096) throw new Error('Request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' });
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function parseCookies(header='') {
  return Object.fromEntries(header.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{
    const i=part.indexOf('=');
    return i<0 ? [part,''] : [part.slice(0,i),part.slice(i+1)];
  }));
}
const consumedOAuthStates = new Set();
let fnoUniverseLoadPromise = null;
let fnoStrategyScanTimer = null;
let fnoStrategyScanBusy = false;
let fnoStrategyScanCursor = 0;
let fnoScannerNextTask = 'SCAN';
let fnoStrategyScanRotation = null;
const fnoResearchWarmupQueue = createResearchWarmupQueue({ maxSize: 500 });
const fnoStrategyScanStats = { status:'NOT_STARTED', scannedCount:0, sliceScannedCount:0, lastSymbol:null, lastStatus:null, lastReason:null, lastScanAt:null, warmupSymbol:null, warmupStatus:'IDLE', warmupQueueDepth:0, warmupCompletedCount:0, warmupRejectedCount:0, warmupRetryCount:0 };
function startFnoStrategyScanner() {
  if (fnoStrategyScanTimer) return;
  fnoStrategyScanStats.status='RUNNING';
  fnoStrategyScanTimer=setInterval(async () => {
    if (fnoStrategyScanBusy) return;
    const snapshot=getFnoUniverseSnapshot();
    const active=snapshot.activeSymbols || [];
    if (!active.length) { fnoStrategyScanStats.status='WAITING_FOR_ACTIVE_FNO_SLICE'; return; }
    if (fnoStrategyScanRotation !== snapshot.rotationIndex) {
      fnoStrategyScanRotation=snapshot.rotationIndex;
      fnoStrategyScanCursor=0;
      fnoStrategyScanStats.sliceScannedCount=0;
      // Research warmups deliberately survive slice rotation; eligible candidates
      // discovered in the previous slice must not be discarded.
    }
    const scanLimit=Math.min(snapshot.scanPerSlice || 12,active.length);
    const shouldWarmup=fnoResearchWarmupQueue.size>0 && (fnoScannerNextTask==='WARMUP' || fnoStrategyScanCursor>=scanLimit);
    if (shouldWarmup) {
      const warmupSymbol=fnoResearchWarmupQueue.take();
      fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
      if (!warmupSymbol) return;
      fnoStrategyScanBusy=true;
      fnoStrategyScanStats.warmupSymbol=warmupSymbol;
      fnoStrategyScanStats.warmupStatus='LOADING_VERIFIED_DAILY_15M';
      try {
        await getDailyHistory(warmupSymbol);
        await getFifteenMinuteHistory(warmupSymbol);
        fnoStrategyScanStats.warmupStatus='VERIFIED_DAILY_15M_CACHED';
        fnoStrategyScanStats.warmupCompletedCount++;
      } catch(error) {
        const retry=fnoResearchWarmupQueue.fail(warmupSymbol);
        fnoStrategyScanStats.warmupStatus=retry.retry?'RETRY_QUEUED':'BLOCKED';
        fnoStrategyScanStats.lastReason=String(error.message||'Research history warmup failed').slice(0,180)+
          (retry.retry?(' · retry '+retry.attempt+'/'+retry.maxAttempts):' · retry limit exhausted; candidate remains unqualified');
        if(retry.retry) fnoStrategyScanStats.warmupRetryCount++;
        else fnoStrategyScanStats.warmupRejectedCount++;
      } finally {
        fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
        fnoScannerNextTask='SCAN';
        fnoStrategyScanBusy=false;
      }
      return;
    }
    if (fnoStrategyScanCursor>=scanLimit) return;
    const symbol=active[fnoStrategyScanCursor++];
    fnoStrategyScanStats.sliceScannedCount++;
    fnoStrategyScanBusy=true;
    try {
      const history=await getFiveMinuteHistory(symbol);
      const latest=getFnoUniverseSnapshot();
      const tick=latest.ticks.get(symbol);
      const market=getMarketData();
      const research=detectNineStrategySetup({
        underlyingCandles:history.candles,underlyingTick:tick,
        isTopGainer:(market.fno?.topGainers||[]).some(item=>item.symbol===symbol),
        researchEnabled:false,now:Date.now()
      });
      fnoStrategyScanStats.scannedCount++;
      fnoStrategyScanStats.lastSymbol=symbol;
      fnoStrategyScanStats.lastStatus=research.status;
      fnoStrategyScanStats.lastReason=research.reason||null;
      fnoStrategyScanStats.lastScanAt=new Date().toISOString();
      if(research.status==='UNDERLYING_SETUP_CONFIRMED') {
        const queued=fnoResearchWarmupQueue.enqueue(symbol);
        fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
        if(queued) {
          fnoStrategyScanStats.warmupSymbol=symbol;
          fnoStrategyScanStats.warmupStatus='QUEUED_AFTER_SLICE_SCAN';
        } else if(!fnoResearchWarmupQueue.has(symbol)) {
          fnoStrategyScanStats.warmupRejectedCount++;
          fnoStrategyScanStats.lastReason='Research warmup queue is at capacity; candidate remains un-warmed and cannot qualify for Top 3';
        }
      }
      fnoScannerNextTask=fnoResearchWarmupQueue.size>0?'WARMUP':'SCAN';
    } catch(error) {
      fnoStrategyScanStats.lastSymbol=symbol;
      fnoStrategyScanStats.lastStatus='DATA_UNAVAILABLE_NO_TRADE';
      fnoStrategyScanStats.lastReason=String(error.message||'F&O history scan failed').slice(0,180);
      fnoStrategyScanStats.lastScanAt=new Date().toISOString();
    } finally { fnoStrategyScanBusy=false; }
  },4500);
  fnoStrategyScanTimer.unref?.();
}

function ensureFyersMarketStarted() {
  const market = startMarketSocket();
  if (!fnoUniverseLoadPromise) {
    fnoUniverseLoadPromise = loadFnoEquityUniverse().then(({ universe, diagnostics }) => {
      const coverage = setFnoUniverse(universe);
      startFnoStrategyScanner();
      console.info('[FYERS_SCANNER] official NSE F&O master diagnostics:', JSON.stringify(diagnostics), 'active socket slots:', coverage.activeCount, 'independent strategy scan slots:', coverage.scanPerSlice || 12);
      return true;
    }).catch(error => {
      fnoUniverseLoadPromise = null;
      console.error('[FYERS_SCANNER] official symbol-master load failed:', String(error?.message || error).slice(0,180));
      return false;
    });
  }
  return market;
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const requestCookies = parseCookies(req.headers.cookie || '');
  if (requestCookies.fyers_session && restoreSessionCookie(requestCookies.fyers_session, {
    appId:process.env.FYERS_APP_ID, appSecret:process.env.FYERS_SECRET_KEY
  })) {
    ensureFyersMarketStarted();
  }
  if (req.method === 'GET' && url.pathname === '/api/market-data') return send(res,200,getMarketData());
  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/history') return send(res,200,await getFiveMinuteHistory(url.searchParams.get('symbol')));
      if (url.pathname === '/api/research-context') {
        const symbol = url.searchParams.get('symbol');
        if (!validateNseSymbol(symbol)) return send(res,400,{status:'INVALID_SYMBOL',reason:'A verified NSE F&O underlying is required'});
        const [daily,fifteenMinute] = await Promise.all([getDailyHistory(symbol),getFifteenMinuteHistory(symbol)]);
        return send(res,200,{status:'RESEARCH_CONTEXT_WARM',symbol,daily:{count:daily.count,source:daily.source},fifteenMinute:{count:fifteenMinute.count,source:fifteenMinute.source}});
      }
      if (url.pathname === '/api/research/universe') {
        const snapshot=getFnoUniverseSnapshot();
        const histories=getCachedResearchHistories();
        const market=getMarketData();
        const result=evaluateRollingFnoUniverse({
          universe:snapshot.universe,ticks:snapshot.ticks,
          fiveMinute:histories.fiveMinute,daily:histories.daily,fifteenMinute:histories.fifteenMinute,
          topGainers:market.fno?.topGainers||[],now:Date.now()
        });
        return send(res,200,{...result,activeSymbols:snapshot.activeSymbols,rotationIndex:snapshot.rotationIndex,
          rotationIntervalMs:snapshot.rotationIntervalMs,scanPerSlice:snapshot.scanPerSlice,symbolCap:snapshot.symbolCap,scanner:fnoStrategyScanStats,
          note:'Only cached FYERS histories and exchange-timestamped ticks are evaluated. Missing/stale inputs are BLOCKED; this endpoint does not fetch synthetic data or place orders.'});
      }
      if (url.pathname === '/api/research') {
        const symbol = url.searchParams.get('symbol');
        if (!validateNseSymbol(symbol)) return send(res,400,{status:'INVALID_SYMBOL',reason:'A verified NSE F&O underlying is required'});
        const market = getMarketData();
        const underlying = market.selectedUnderlying;
        if (!underlying?.fresh || underlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Fresh selected-underlying FYERS tick is required for independent research'});
        }
        const [fiveMinute,daily,fifteenMinute] = await Promise.all([
          getFiveMinuteHistory(symbol), getDailyHistory(symbol), getFifteenMinuteHistory(symbol)
        ]);
        const latestMarket = getMarketData();
        const latestUnderlying = latestMarket.selectedUnderlying;
        if (!latestUnderlying?.fresh || latestUnderlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Underlying tick became stale while verified research history was loading'});
        }
        const isTopGainer = (latestMarket.fno?.topGainers || []).some(item => item.symbol === symbol);
        const research = detectNineStrategySetup({
          underlyingCandles:fiveMinute.candles, underlyingTick:latestUnderlying,
          dailyCandles:daily.candles, fifteenMinuteCandles:fifteenMinute.candles,
          isTopGainer, researchEnabled:true, now:Date.now()
        });
        return send(res,200,{
          status:research.status,
          researchRanking:research.researchRanking || [],
          reason:research.reason || (research.status === 'NO_TRADE' ? 'No strategy passed the verified setup filters' : ''),
          research:research.research || null,
          strategyLedger:research.strategyLedger || [],
          underlying:symbol,
          source:'FYERS_VERIFIED_DAILY_15M_5M_OHLCV',
          asOfExchangeTime:latestUnderlying.exchangeTime
        });
      }
      if (url.pathname === '/api/quotes') {
        const symbols = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        return send(res,200,await getFyersQuotes(symbols));
      }
      if (url.pathname === '/api/option-chain') return send(res,200,await getFyersOptionChain(url.searchParams.get('symbol'),url.searchParams.get('strikecount') || 10,url.searchParams.get('timestamp') || ''));
      if (url.pathname === '/api/positions') return send(res,200,await getFyersPositions());
      if (url.pathname === '/api/orderbook') return send(res,200,await getFyersOrderbook());
    } catch (error) {
      const rateLimited = /429|cooldown/i.test(String(error.message));
      return send(res,rateLimited ? 429 : 503,{status:rateLimited ? 'RATE_LIMITED' : 'DATA_UNAVAILABLE',reason:String(error.message || 'FYERS read-only request failed').slice(0,180)});
    }
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(res,200,{ok:true,app:'Upgrade AI Pro',mode:'NSE_ONLY',marketData:'NOT_CONNECTED',orders:'DISABLED'});
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const market = getMarketData();
    return send(res,200,{
    app:'Upgrade AI Pro', exchange:'NSE', provider:'FYERS', feed:assessFeed(market.selectedUnderlying), auth:getAuthStatus(), marketData:market, rest:getRestDiagnostics(),
    configuration:{
      appIdConfigured:Boolean(process.env.FYERS_APP_ID?.trim()),
      appIdHasNewFormat: Boolean(process.env.FYERS_APP_ID?.trim().endsWith('-200')),
      redirectUriConfigured:Boolean(process.env.FYERS_REDIRECT_URI?.trim()),
      redirectUriMatchesExpected:process.env.FYERS_REDIRECT_URI?.trim() === EXPECTED_REDIRECT_URI,
      secretConfigured:Boolean(process.env.FYERS_SECRET_KEY?.trim())
    },
    fnoCoverage:market.fno, scanner:{mode:'ROLLING_FNO_NINE_STRATEGY_EVALUATION',...fnoStrategyScanStats,scanPerSlice:getFnoUniverseSnapshot().scanPerSlice,rotationIntervalMs:60000,simultaneous:false}, strategyEngine:'NINE_STRATEGY_WITH_VERIFIED_MULTI_TIMEFRAME_RESEARCH · ROLLING F&O UNIVERSE EVALUATION · CACHED FYERS DATA ONLY', orderPlacementEnabled:tradingEnabled(), marketSession:'NSE 09:15-15:30 Asia/Kolkata'
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/fyers/login') {
    console.info('[FYERS_OAUTH] login route reached');
    try {
      const auth = getAuthStatus();
      if (auth.tokenStored) {
        ensureFyersMarketStarted();
        const session = createSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
        const sessionCookie = `fyers_session=${session.value}; Max-Age=${session.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
        console.info('[FYERS_OAUTH] existing authenticated session reused; token exchange skipped');
        res.writeHead(302,{location:'/?fyers=session-restored','set-cookie':sessionCookie,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
      }
      const login = createLoginUrl({ appId:process.env.FYERS_APP_ID, redirectUri:process.env.FYERS_REDIRECT_URI });
      console.info('[FYERS_OAUTH] redirect generated; app id configured:', Boolean(process.env.FYERS_APP_ID?.trim()), 'redirect matches expected:', process.env.FYERS_REDIRECT_URI?.trim() === EXPECTED_REDIRECT_URI);
      res.writeHead(302,{location:login.url,'set-cookie':`fyers_oauth_state=${login.state}; Max-Age=600; Path=/api/fyers; HttpOnly; Secure; SameSite=Lax`,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) {
      console.error('[FYERS_OAUTH] login setup failed:', error.message);
      return send(res,503,{status:'NOT_CONFIGURED',reason:error.message});
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/fyers/auth/callback') {
    console.info('[FYERS_OAUTH] callback route reached');
    const state = url.searchParams.get('state');
    const authCode = url.searchParams.get('auth_code');
    const cookies = parseCookies(req.headers.cookie || '');
    const clearStateCookie = 'fyers_oauth_state=; Max-Age=0; Path=/api/fyers; HttpOnly; Secure; SameSite=Lax';
    if (!verifyLoginState(state,cookies.fyers_oauth_state) || consumedOAuthStates.has(state)) {
      console.warn('[FYERS_OAUTH] callback rejected: state missing, mismatched or already consumed');
      res.setHeader('set-cookie',clearStateCookie);
      return send(res,400,{status:'REJECTED',reason:'OAuth state is missing, mismatched or already used. Start Connect once again.'});
    }
    consumedOAuthStates.add(state);
    if (consumedOAuthStates.size > 2000) consumedOAuthStates.delete(consumedOAuthStates.values().next().value);
    res.setHeader('set-cookie',clearStateCookie);
    if (!authCode) {
      console.warn('[FYERS_OAUTH] callback missing auth_code');
      return send(res,400,{status:'FAILED',reason:'FYERS authorization code was not returned'});
    }
    try {
      await exchangeAuthCode({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY,authCode});
      console.info('[FYERS_OAUTH] token exchange succeeded; token value withheld');
      const session = createSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
      const sessionCookie = `fyers_session=${session.value}; Max-Age=${session.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
      const market = ensureFyersMarketStarted();
      console.info('[FYERS_DATA] socket start requested; status:', market.status, 'encrypted session cookie issued');
      res.writeHead(302,{location:'/?fyers=connected','set-cookie':[clearStateCookie,sessionCookie],'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) {
      const d = error.fyersDiagnostics || {};
      console.error('[FYERS_OAUTH] token exchange failed:', error.message,
        JSON.stringify({httpStatus:d.status || null, elapsedMs:d.elapsedMs || null, retryAfter:d.retryAfter || null, cfRay:d.cfRay || null, server:d.server || null, contentType:d.contentType || null}));
      const upstream429 = /FYERS_UPSTREAM_HTTP_429/.test(String(error.message));
      return send(res,upstream429 ? 429 : 502,{status:upstream429 ? 'FYERS_UPSTREAM_RATE_LIMIT' : 'TOKEN_EXCHANGE_FAILED',reason:error.message});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/select-underlying') {
    try {
      const body = await readJson(req);
      const result = setSelectedUnderlyingSymbol(body.symbol || null);
      if (body.symbol && result.status !== 'UNDERLYING_PINNED_TO_SOCKET_SLICE' && result.status !== 'UNCHANGED') return send(res,400,{status:'UNDERLYING_NOT_VERIFIED',reason:'Underlying is not in the official active NSE F&O universe'});
      return send(res,200,result);
    } catch (error) {
      return send(res,400,{status:'UNDERLYING_NOT_VERIFIED',reason:String(error.message || 'Underlying selection failed').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/evaluate-setup') {
    try {
      const body = await readJson(req);
      const market = getMarketData();
      const underlying = market.selectedUnderlying;
      const option = market.selectedOption;
      if (!underlying?.fresh || underlying.symbol !== body.underlying) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Selected underlying tick is not fresh'});
      if (!option?.fresh || option.symbol !== body.contract) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Selected option tick is not fresh'});
      const contract = getVerifiedOptionContract(body.contract);
      const [underlyingHistory,optionHistory,dailyHistory,fifteenMinuteHistory] = await Promise.all([getFiveMinuteHistory(body.underlying),getFiveMinuteHistory(body.contract),getDailyHistory(body.underlying),getFifteenMinuteHistory(body.underlying)]);
      // REST history requests are serialized to respect FYERS pacing. Re-read the
      // WebSocket snapshot afterwards so the 10-second freshness gate uses current ticks.
      const latestMarket=getMarketData();
      const latestUnderlying=latestMarket.selectedUnderlying,latestOption=latestMarket.selectedOption;
      if(!latestUnderlying?.fresh||latestUnderlying.symbol!==body.underlying)
        return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Underlying tick became stale while verified research history was loading'});
      if(!latestOption?.fresh||latestOption.symbol!==body.contract)
        return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Option tick became stale while verified research history was loading'});
      const isTopGainer = (latestMarket.fno?.topGainers || []).some(item=>item.symbol===body.underlying);
      const setup = evaluateNineStrategies({underlyingCandles:underlyingHistory.candles,underlyingTick:latestUnderlying,optionCandles:optionHistory.candles,optionTick:latestOption,contract,dailyCandles:dailyHistory.candles,fifteenMinuteCandles:fifteenMinuteHistory.candles,isTopGainer,researchEnabled:true,now:Date.now()});
      return send(res,200,{...setup,underlying:body.underlying,contract:body.contract,source:'FYERS_VERIFIED_DATA'});
    } catch (error) {
      const rateLimited=/429|cooldown/i.test(String(error.message));
      return send(res,rateLimited?429:200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:String(error.message||'Setup verification unavailable').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/auto-select-option') {
    try {
      const body = await readJson(req);
      if (!validateNseSymbol(body.underlying) || !['LONG','SHORT'].includes(body.side)) {
        return send(res,400,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Verified NSE underlying and confirmed LONG/SHORT direction are required'});
      }
      const beforeChain = getMarketData();
      if (!beforeChain.selectedUnderlying?.fresh || beforeChain.selectedUnderlying.symbol !== body.underlying) {
        return send(res,200,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Fresh selected-underlying FYERS tick is required before strike selection'});
      }
      const chainPayload = await getFyersOptionChain(body.underlying,10,body.timestamp || '');
      const chainData = chainPayload.data || chainPayload;
      const latestUnderlying = getMarketData().selectedUnderlying;
      if (!latestUnderlying?.fresh || latestUnderlying.symbol !== body.underlying) {
        return send(res,200,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Underlying tick became stale while the FYERS option chain was loading'});
      }
      const selection = chooseDirectionalOption({
        optionsChain:chainData.optionsChain,
        underlyingPrice:Number(latestUnderlying.price),
        side:body.side
      });
      if (selection.status !== 'CANDIDATE_SELECTED') return send(res,200,{status:'AUTO_OPTION_UNAVAILABLE',reason:selection.reason});
      const contract = getVerifiedOptionContract(selection.symbol);
      const requestedExpiry = Number(body.timestamp);
      const requestedExpirySeconds = Number.isFinite(requestedExpiry) && requestedExpiry > 0
        ? (requestedExpiry > 1e12 ? requestedExpiry / 1000 : requestedExpiry) : null;
      const expiryDay = value => new Date((Number(value) + 19800) * 1000).toISOString().slice(0,10);
      const expectedUnderlying=body.underlying.replace(/^NSE:/,'').replace(/-EQ$/,'').toUpperCase();
      if (contract.side !== selection.side || contract.strike !== selection.strike ||
          contract.underlying !== expectedUnderlying ||
          (requestedExpirySeconds && expiryDay(contract.expiry) !== expiryDay(requestedExpirySeconds))) {
        return send(res,409,{status:'AUTO_OPTION_MASTER_MISMATCH',reason:'FYERS chain candidate underlying, side, strike or expiry does not match the official active contract master'});
      }
      const subscription = setSelectedOptionSymbol(contract.symbol);
      if (subscription?.status === 'SUBSCRIPTION_FAILED') {
        return send(res,503,{status:'AUTO_OPTION_SUBSCRIPTION_FAILED',reason:subscription.reason || 'FYERS option subscription failed'});
      }
      return send(res,200,{status:'AUTO_CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED',selection,contract,subscription});
    } catch(error) {
      const rateLimited=/429|cooldown/i.test(String(error.message));
      return send(res,rateLimited?429:503,{status:'AUTO_OPTION_UNAVAILABLE',reason:String(error.message||'Automatic option selection failed').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/select-option') {
    try {
      const body = await readJson(req);
      if (body.symbol === null) {
        setSelectedOptionSymbol(null);
        return send(res,200,{status:'OPTION_SUBSCRIPTION_CLEARED'});
      }
      const contract = getVerifiedOptionContract(body.symbol);
      const selectedUnderlying=getMarketData().selectedUnderlying;
      const expectedUnderlying=String(selectedUnderlying?.symbol||'').replace(/^NSE:/,'').replace(/-EQ$/,'').toUpperCase();
      if(!expectedUnderlying||contract.underlying!==expectedUnderlying) {
        return send(res,400,{status:'CONTRACT_NOT_VERIFIED',reason:'Option contract underlying does not match the currently selected FYERS NSE underlying'});
      }
      const subscription = setSelectedOptionSymbol(contract.symbol);
      if (subscription?.status === 'SUBSCRIPTION_FAILED') {
        return send(res,503,{status:'OPTION_SUBSCRIPTION_FAILED',reason:subscription.reason || 'FYERS option subscription failed',subscription});
      }
      return send(res,200,{status:'CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED',contract,subscription});
    } catch (error) {
      return send(res,400,{status:'CONTRACT_NOT_VERIFIED',reason:String(error.message || 'Option contract verification failed').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/orders')) return send(res,423,{status:'BLOCKED',reason:'Order placement is disabled during build and initial verification'});
  if (req.method !== 'GET') return send(res,405,{error:'Method not allowed'});
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const safe = normalize(requested).replace(/^([.][.][/\\\\])+/, '');
  try {
    const path = join(root,safe);
    if (!path.startsWith(root)) return send(res,403,{error:'Forbidden'});
    const data = await readFile(path);
    return send(res,200,data,mime[extname(path)] || 'application/octet-stream');
  } catch { return send(res,404,{error:'Not found'}); }
});
server.listen(port,'0.0.0.0',()=>console.log(`Upgrade AI Pro listening on ${port}`));
