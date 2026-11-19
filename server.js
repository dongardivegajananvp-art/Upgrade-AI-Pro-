import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessFeed, tradingEnabled } from './src/safety.js';
import { createLoginUrl, verifyLoginState, exchangeAuthCode, getAuthStatus } from './src/fyers-auth.js';
import { startMarketSocket, getMarketData, setFnoUniverse, setSelectedOptionSymbol } from './src/fyers-market-socket.js';
import { loadFnoEquityUniverse, getVerifiedOptionContract } from './src/fyers-symbol-master.js';
import { getFiveMinuteHistory, getFyersQuotes, getFyersOptionChain, getFyersPositions, getFyersOrderbook, getRestDiagnostics } from './src/fyers-rest.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const EXPECTED_REDIRECT_URI = 'https://upgrade-ai-pro.onrender.com/api/fyers/auth/callback';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json' };

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
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/market-data') return send(res,200,getMarketData());
  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/history') return send(res,200,await getFiveMinuteHistory(url.searchParams.get('symbol')));
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
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res,200,{
    app:'Upgrade AI Pro', exchange:'NSE', provider:'FYERS', feed:assessFeed(null), auth:getAuthStatus(), marketData:getMarketData(), rest:getRestDiagnostics(),
    configuration:{
      appIdConfigured:Boolean(process.env.FYERS_APP_ID?.trim()),
      appIdHasNewFormat: Boolean(process.env.FYERS_APP_ID?.trim().endsWith('-200')),
      redirectUriConfigured:Boolean(process.env.FYERS_REDIRECT_URI?.trim()),
      redirectUriMatchesExpected:process.env.FYERS_REDIRECT_URI?.trim() === EXPECTED_REDIRECT_URI,
      secretConfigured:Boolean(process.env.FYERS_SECRET_KEY?.trim())
    },
    fnoCoverage:getMarketData().fno, scanner:'NOT_CONNECTED', strategyEngine:'NINE_STRATEGIES_NOT_YET_CONNECTED_TO_LIVE_SCAN', orderPlacementEnabled:tradingEnabled(), marketSession:'NSE 09:15-15:30 Asia/Kolkata'
  });
  if (req.method === 'GET' && url.pathname === '/api/fyers/login') {
    console.info('[FYERS_OAUTH] login route reached');
    try {
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
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const i=part.indexOf('=');return [part.slice(0,i),part.slice(i+1)];}));
    const clearStateCookie = 'fyers_oauth_state=; Max-Age=0; Path=/api/fyers; HttpOnly; Secure; SameSite=Lax';
    if (!verifyLoginState(state,cookies.fyers_oauth_state)) {
      console.warn('[FYERS_OAUTH] callback rejected: state cookie missing or mismatched');
      res.setHeader('set-cookie',clearStateCookie);
      return send(res,400,{status:'REJECTED',reason:'OAuth state cookie is missing or does not match. Start Connect again.'});
    }
    res.setHeader('set-cookie',clearStateCookie);
    if (!authCode) {
      console.warn('[FYERS_OAUTH] callback missing auth_code');
      return send(res,400,{status:'FAILED',reason:'FYERS authorization code was not returned'});
    }
    try {
      await exchangeAuthCode({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY,authCode});
      console.info('[FYERS_OAUTH] token exchange succeeded; token value withheld');
      const market = startMarketSocket();
      console.info('[FYERS_DATA] socket start requested; status:', market.status);
      loadFnoEquityUniverse().then(({ universe }) => {
        const coverage = setFnoUniverse(universe);
        console.info('[FYERS_SCANNER] official NSE F&O underlyings loaded:', coverage.universeCount, 'active socket slots:', coverage.activeCount);
      }).catch(error => {
        console.error('[FYERS_SCANNER] official symbol-master load failed:', String(error?.message || error).slice(0,180));
      });
      res.writeHead(302,{location:'/?fyers=connected','cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) {
      console.error('[FYERS_OAUTH] token exchange failed:', error.message);
      return send(res,502,{status:'TOKEN_EXCHANGE_FAILED',reason:error.message});
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
      setSelectedOptionSymbol(contract.symbol);
      return send(res,200,{status:'CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED',contract});
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
