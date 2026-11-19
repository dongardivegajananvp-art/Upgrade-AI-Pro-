import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessFeed, tradingEnabled } from './src/safety.js';
import { createLoginUrl, consumeLoginState, exchangeAuthCode, getAuthStatus } from './src/fyers-auth.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json' };

function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res,200,{ok:true,app:'Upgrade AI Pro',mode:'NSE_ONLY',marketData:'NOT_CONNECTED',orders:'DISABLED'});
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res,200,{
    app:'Upgrade AI Pro', exchange:'NSE', provider:'FYERS', feed:assessFeed(null), auth:getAuthStatus(),
    scanner:'NOT_STARTED', orderPlacementEnabled:tradingEnabled(), marketSession:'NSE 09:15-15:30 Asia/Kolkata'
  });
  if (req.method === 'GET' && url.pathname === '/api/fyers/login') {
    try {
      const loginUrl = createLoginUrl({ appId:process.env.FYERS_APP_ID, redirectUri:process.env.FYERS_REDIRECT_URI });
      res.writeHead(302,{location:loginUrl,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) { return send(res,503,{status:'NOT_CONFIGURED',reason:error.message}); }
  }
  if (req.method === 'GET' && url.pathname === '/api/fyers/auth/callback') {
    const state = url.searchParams.get('state');
    const authCode = url.searchParams.get('auth_code');
    if (!consumeLoginState(state)) return send(res,400,{status:'REJECTED',reason:'OAuth state is missing, expired, or already used'});
    if (!authCode) return send(res,400,{status:'FAILED',reason:'FYERS authorization code was not returned'});
    try {
      await exchangeAuthCode({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY,authCode});
      res.writeHead(302,{location:'/?fyers=connected','cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) { return send(res,502,{status:'TOKEN_EXCHANGE_FAILED',reason:error.message}); }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/orders')) return send(res,423,{status:'BLOCKED',reason:'Order placement is disabled during build and initial verification'});
  if (req.method !== 'GET') return send(res,405,{error:'Method not allowed'});
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const safe = normalize(requested).replace(/^([.][.][/\\])+/, '');
  try {
    const path = join(root,safe);
    if (!path.startsWith(root)) return send(res,403,{error:'Forbidden'});
    const data = await readFile(path);
    return send(res,200,data,mime[extname(path)] || 'application/octet-stream');
  } catch { return send(res,404,{error:'Not found'}); }
});
server.listen(port,'0.0.0.0',()=>console.log(`Upgrade AI Pro listening on ${port}`));
