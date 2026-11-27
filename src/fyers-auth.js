import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
const TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';
const REFRESH_TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-refresh-token';
const REFRESH_COOKIE_VERSION = 1;
const REFRESH_TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
let refreshToken = null;
let refreshTokenIssuedAt = null;
let refreshInFlight = false;
const SESSION_COOKIE_VERSION = 1;
let accessToken = null;
let tokenReceivedAt = null;
let lastAuthError = null;
let authInFlight = false;
const usedAuthCodeHashes = new Set();

function tokenExpiryAt(receivedAt) {
  const istOffsetMs = 330 * 60 * 1000;
  const receivedIst = new Date(receivedAt + istOffsetMs);
  let expiry = Date.UTC(receivedIst.getUTCFullYear(), receivedIst.getUTCMonth(), receivedIst.getUTCDate(), 6, 30) - istOffsetMs;
  if (receivedIst.getUTCHours() > 6 || (receivedIst.getUTCHours() === 6 && receivedIst.getUTCMinutes() >= 30)) expiry += 24 * 60 * 60 * 1000;
  return expiry;
}

function refreshSessionKey(appId, appSecret) {
  if (!appId || !appSecret) throw new Error('FYERS refresh-session encryption configuration is missing');
  return createHash('sha256').update(`upgrade-ai-pro:fyers-refresh-session:v${REFRESH_COOKIE_VERSION}:${appId}:${appSecret}`).digest();
}

function sessionKey(appId, appSecret) {
  if (!appId || !appSecret) throw new Error('FYERS session encryption configuration is missing');
  return createHash('sha256').update(`upgrade-ai-pro:fyers-session:v${SESSION_COOKIE_VERSION}:${appId}:${appSecret}`).digest();
}

export function createLoginUrl({ appId, redirectUri, now = Date.now() }) {
  if (!appId || !redirectUri) throw new Error('FYERS_APP_ID and FYERS_REDIRECT_URI are required');
  const state = randomBytes(24).toString('hex');
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { url: url.toString(), state, expiresAt: now + 10 * 60 * 1000 };
}

// OAuth state is bound to a short-lived HttpOnly cookie and consumed once by the callback.
export function verifyLoginState(state, cookieState) {
  if (typeof state !== 'string' || typeof cookieState !== 'string') return false;
  if (!/^[a-f0-9]{48}$/.test(state) || !/^[a-f0-9]{48}$/.test(cookieState)) return false;
  const a = Buffer.from(state, 'hex');
  const b = Buffer.from(cookieState, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Atomically validate and consume one OAuth state in the process-local replay guard.
export function consumeLoginState(state, cookieState, consumedStates, maxEntries = 2000) {
  if (!(consumedStates instanceof Set) || !verifyLoginState(state, cookieState) || consumedStates.has(state)) return false;
  consumedStates.add(state);
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 2000));
  while (consumedStates.size > limit) consumedStates.delete(consumedStates.values().next().value);
  return true;
}

// Persist the short-lived broker session in an encrypted, HttpOnly browser cookie.
// This survives Render Free instance sleep/restarts without a paid database or disk.
export function createSessionCookie({ appId, appSecret, now = Date.now() } = {}) {
  if (!accessToken || !tokenReceivedAt) throw new Error('No authenticated FYERS session is available');
  const expiresAt = tokenExpiryAt(tokenReceivedAt);
  if (now >= expiresAt) throw new Error('FYERS session has expired; authenticate again');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(appId, appSecret), iv);
  const payload = Buffer.from(JSON.stringify({ v: SESSION_COOKIE_VERSION, token: accessToken, issuedAt: tokenReceivedAt, expiresAt }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return { value: packed, maxAge: Math.max(0, Math.floor((expiresAt - now) / 1000)), expiresAt };
}

export function createRefreshSessionCookie({ appId, appSecret, now = Date.now() } = {}) {
  if (!refreshToken || !refreshTokenIssuedAt) return null;
  const expiresAt = refreshTokenIssuedAt + REFRESH_TOKEN_MAX_AGE_MS;
  if (now >= expiresAt) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', refreshSessionKey(appId, appSecret), iv);
  const payload = Buffer.from(JSON.stringify({ v:REFRESH_COOKIE_VERSION, token:refreshToken, issuedAt:refreshTokenIssuedAt, expiresAt }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const packed = Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  return { value:packed, maxAge:Math.max(0,Math.floor((expiresAt-now)/1000)), expiresAt };
}

export function restoreRefreshSessionCookie(value, { appId, appSecret, now = Date.now() } = {}) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 3800) return false;
  try {
    const packed=Buffer.from(value,'base64url');
    if(packed.toString('base64url')!==value || packed.length<29) return false;
    const decipher=createDecipheriv('aes-256-gcm',refreshSessionKey(appId,appSecret),packed.subarray(0,12));
    decipher.setAuthTag(packed.subarray(12,28));
    const payload=JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString('utf8'));
    if(payload.v!==REFRESH_COOKIE_VERSION || typeof payload.token!=='string' || !payload.token ||
       !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt) ||
       payload.expiresAt!==payload.issuedAt+REFRESH_TOKEN_MAX_AGE_MS || now>=payload.expiresAt || payload.issuedAt>now+60000) return false;
    if(refreshToken && refreshTokenIssuedAt) return payload.token===refreshToken && payload.issuedAt===refreshTokenIssuedAt;
    refreshToken=payload.token; refreshTokenIssuedAt=payload.issuedAt;
    return true;
  } catch { return false; }
}

export async function refreshAccessToken({ appId, appSecret, pin, now = Date.now() } = {}) {
  if(!appId || !appSecret || !pin) throw new Error('FYERS_APP_ID, FYERS_SECRET_KEY and FYERS_PIN are required for refresh');
  if(!refreshToken || !refreshTokenIssuedAt || now>=refreshTokenIssuedAt+REFRESH_TOKEN_MAX_AGE_MS) {
    refreshToken=null; refreshTokenIssuedAt=null;
    throw new Error('FYERS refresh token is missing or expired; fresh OAuth login required');
  }
  if(refreshInFlight) throw new Error('FYERS token refresh already in progress; duplicate request suppressed');
  if(accessToken && tokenReceivedAt && now < tokenExpiryAt(tokenReceivedAt)-5*60*1000) {
    return { refreshed:false, receivedAt:tokenReceivedAt, reason:'ACCESS_TOKEN_STILL_VALID' };
  }
  refreshInFlight=true;
  const appIdHash=createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  const startedAt=Date.now();
  try {
    const response=await fetch(REFRESH_TOKEN_URL,{
      method:'POST',headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({grant_type:'refresh_token',appIdHash,refresh_token:refreshToken,pin:String(pin)}),
      signal:AbortSignal.timeout(15000)
    });
    const rawBody=await response.text().catch(()=>'');
    let body={}; try { body=rawBody?JSON.parse(rawBody):{}; } catch {}
    if(!response.ok || body.s!=='ok' || typeof body.access_token!=='string' || !body.access_token) {
      const message=String(body.message||body.error||`FYERS refresh failed (HTTP ${response.status})`).slice(0,240);
      lastAuthError=message;
      const error=new Error(message);
      error.fyersDiagnostics={status:response.status,elapsedMs:Date.now()-startedAt};
      throw error;
    }
    accessToken=body.access_token;
    tokenReceivedAt=Date.now();
    lastAuthError=null;
    return {refreshed:true,receivedAt:tokenReceivedAt};
  } catch(error) {
    lastAuthError=String(error?.message||error).slice(0,480);
    throw error;
  } finally { refreshInFlight=false; }
}

export function restoreSessionCookie(value, { appId, appSecret, now = Date.now() } = {}) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 3800) return false;
  if (accessToken && tokenReceivedAt && now >= tokenExpiryAt(tokenReceivedAt)) {
    accessToken = null;
    tokenReceivedAt = null;
  }
  try {
    const packed = Buffer.from(value, 'base64url');
    // Buffer's base64url decoder accepts non-canonical trailing-bit variants.
    // Require a byte-for-byte canonical round trip before decrypting the cookie.
    if (packed.toString('base64url') !== value || packed.length < 29) return false;
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(appId, appSecret), iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    if (payload.v !== SESSION_COOKIE_VERSION || typeof payload.token !== 'string' || !payload.token || !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)) return false;
    if (now >= payload.expiresAt || payload.expiresAt !== tokenExpiryAt(payload.issuedAt) || payload.issuedAt > now + 60000) return false;
    // An active in-memory session must match the authenticated cookie exactly.
    // Never treat an arbitrary cookie as valid merely because another request
    // has already populated this process with a broker token.
    if (accessToken && tokenReceivedAt) {
      return payload.token === accessToken && payload.issuedAt === tokenReceivedAt;
    }
    accessToken = payload.token;
    tokenReceivedAt = payload.issuedAt;
    lastAuthError = null;
    return true;
  } catch {
    return false;
  }
}

// Persist an active REST cooldown in a small encrypted browser cookie. Render Free
// has no durable local disk; this lets the authenticated workstation restore the
// exact FYERS Retry-After/backoff deadline after an instance restart without a DB.
const REST_SAFETY_COOKIE_VERSION = 1;
function restSafetyKey(appId, appSecret) {
  if (!appId || !appSecret) throw new Error('FYERS REST safety encryption configuration is missing');
  return createHash('sha256').update(`upgrade-ai-pro:fyers-rest-safety:v${REST_SAFETY_COOKIE_VERSION}:${appId}:${appSecret}`).digest();
}
export function createRestSafetyCookie({ appId, appSecret, state = {}, now = Date.now() } = {}) {
  const cooldownUntil = Number(state.cooldownUntil);
  if (!Number.isFinite(cooldownUntil) || cooldownUntil <= now) return null;
  const maxDeadline = now + 30 * 24 * 60 * 60 * 1000;
  const boundedCooldownUntil = Math.min(cooldownUntil, maxDeadline);
  const expiresAt = Math.min(maxDeadline, Math.max(now + 24 * 60 * 60 * 1000, boundedCooldownUntil + 60 * 60 * 1000));
  const safeState = {
    cooldownUntil: boundedCooldownUntil,
    rateLimitDayKey: typeof state.rateLimitDayKey === 'string' ? state.rateLimitDayKey.slice(0,10) : null,
    rateLimitCountToday: Math.max(0, Math.floor(Number(state.rateLimitCountToday) || 0)),
    cloudflareRateLimitCountToday: Math.max(0, Math.floor(Number(state.cloudflareRateLimitCountToday) || 0)),
    unknownRateLimitCountToday: Math.max(0, Math.floor(Number(state.unknownRateLimitCountToday) || 0)),
    lastRateLimitAt: typeof state.lastRateLimitAt === 'string' ? state.lastRateLimitAt.slice(0,40) : null,
    lastRateLimitKind: typeof state.lastRateLimitKind === 'string' ? state.lastRateLimitKind.slice(0,40) : null
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', restSafetyKey(appId, appSecret), iv);
  const payload = Buffer.from(JSON.stringify({ v:REST_SAFETY_COOKIE_VERSION, issuedAt:now, expiresAt, state:safeState }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return { value:packed, maxAge:Math.max(60,Math.floor((expiresAt-now)/1000)), expiresAt };
}
export function restoreRestSafetyCookie(value, { appId, appSecret, now = Date.now() } = {}) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 1800) return null;
  try {
    const packed = Buffer.from(value,'base64url');
    if (packed.toString('base64url') !== value || packed.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm',restSafetyKey(appId,appSecret),packed.subarray(0,12));
    decipher.setAuthTag(packed.subarray(12,28));
    const payload = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString('utf8'));
    const state = payload.state;
    if (payload.v !== REST_SAFETY_COOKIE_VERSION || !Number.isFinite(payload.issuedAt) ||
        !Number.isFinite(payload.expiresAt) || now >= payload.expiresAt || payload.issuedAt > now + 60000 ||
        !state || typeof state !== 'object' || !Number.isFinite(Number(state.cooldownUntil)) ||
        Number(state.cooldownUntil) <= 0 || Number(state.cooldownUntil) > now + 30 * 24 * 60 * 60 * 1000) return null;
    return {
      cooldownUntil:Number(state.cooldownUntil),
      rateLimitDayKey:typeof state.rateLimitDayKey === 'string' ? state.rateLimitDayKey : null,
      rateLimitCountToday:Math.max(0,Math.floor(Number(state.rateLimitCountToday)||0)),
      cloudflareRateLimitCountToday:Math.max(0,Math.floor(Number(state.cloudflareRateLimitCountToday)||0)),
      unknownRateLimitCountToday:Math.max(0,Math.floor(Number(state.unknownRateLimitCountToday)||0)),
      lastRateLimitAt:typeof state.lastRateLimitAt === 'string' ? state.lastRateLimitAt : null,
      lastRateLimitKind:typeof state.lastRateLimitKind === 'string' ? state.lastRateLimitKind : null
    };
  } catch {
    return null;
  }
}

export async function exchangeAuthCode({ appId, appSecret, authCode, now = Date.now() }) {
  if (!appId || !appSecret || !authCode) throw new Error('FYERS OAuth configuration or authorization code is missing');
  if (authInFlight) throw new Error('FYERS token exchange is already in progress; duplicate request suppressed');
  const codeHash = createHash('sha256').update(authCode).digest('hex');
  if (usedAuthCodeHashes.has(codeHash)) throw new Error('FYERS authorization code has already been processed; start a fresh login only if the session is not active');
  authInFlight = true;
  usedAuthCodeHashes.add(codeHash);
  if (usedAuthCodeHashes.size > 1000) usedAuthCodeHashes.delete(usedAuthCodeHashes.values().next().value);
  const appIdHash = createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  const startedAt = Date.now();
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode }),
      signal: AbortSignal.timeout(15000)
    });
    const rawBody = await response.text().catch(() => '');
    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
    const diagnostics = {
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      retryAfter: response.headers.get('retry-after'),
      cfRay: response.headers.get('cf-ray'),
      server: response.headers.get('server'),
      contentType: response.headers.get('content-type'),
      responseMessage: String(body.message || body.error || rawBody.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim()).slice(0, 240)
    };
    if (!response.ok || body.s !== 'ok' || !body.access_token) {
      const message = response.status === 429
        ? `FYERS_UPSTREAM_HTTP_429: ${diagnostics.responseMessage || 'Upstream rate limit response'}; retry-after=${diagnostics.retryAfter || 'not-provided'}; cf-ray=${diagnostics.cfRay || 'not-provided'}; server=${diagnostics.server || 'not-provided'}; content-type=${diagnostics.contentType || 'not-provided'}`
        : String(body.message || body.error || `FYERS token exchange failed (HTTP ${response.status})`).slice(0, 240);
      lastAuthError = message;
      const error = new Error(message);
      error.fyersDiagnostics = diagnostics;
      throw error;
    }
    accessToken = body.access_token;
    tokenReceivedAt = Date.now();
    if (typeof body.refresh_token === 'string' && body.refresh_token) {
      refreshToken = body.refresh_token;
      refreshTokenIssuedAt = tokenReceivedAt;
    }
    lastAuthError = null;
    return { connected: true, receivedAt: tokenReceivedAt, refreshTokenStored:Boolean(refreshToken) };
  } catch (error) {
    lastAuthError = String(error?.message || error).slice(0, 480);
    throw error;
  } finally {
    authInFlight = false;
  }
}

export function getAuthStatus(now = Date.now()) {
  if (accessToken && tokenReceivedAt && now >= tokenExpiryAt(tokenReceivedAt)) {
    accessToken = null;
    tokenReceivedAt = null;
  }
  return { status: accessToken ? 'AUTHENTICATED_FEED_NOT_CONNECTED' : 'NOT_AUTHENTICATED', tokenStored: Boolean(accessToken), tokenReceivedAt, authInFlight, refreshTokenStored:Boolean(refreshToken), refreshInFlight, refreshTokenExpiresAt:refreshTokenIssuedAt ? new Date(refreshTokenIssuedAt+REFRESH_TOKEN_MAX_AGE_MS).toISOString() : null, lastError: lastAuthError };
}

export function getAccessTokenForServer() { return accessToken; }
