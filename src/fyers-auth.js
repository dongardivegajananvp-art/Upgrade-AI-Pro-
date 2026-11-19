import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
const TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';
let accessToken = null;
let tokenReceivedAt = null;
let lastAuthError = null;
let authRetryAfter = 0;
let authInFlight = false;

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

// Bind the random OAuth state to a short-lived HttpOnly cookie. This avoids
// process-local storage, which is unreliable across restarts/instances.
export function verifyLoginState(state, cookieState) {
  if (typeof state !== 'string' || typeof cookieState !== 'string') return false;
  if (!/^[a-f0-9]{48}$/.test(state) || !/^[a-f0-9]{48}$/.test(cookieState)) return false;
  const a = Buffer.from(state, 'hex');
  const b = Buffer.from(cookieState, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function exchangeAuthCode({ appId, appSecret, authCode, now = Date.now() }) {
  if (!appId || !appSecret || !authCode) throw new Error('FYERS OAuth configuration or authorization code is missing');
  if (authInFlight) throw new Error('FYERS token exchange is already in progress; wait for its result');
  if (now < authRetryAfter) {
    const seconds = Math.ceil((authRetryAfter - now) / 1000);
    throw new Error(`FYERS_AUTH_RATE_LIMIT_COOLDOWN: wait ${seconds}s before retrying token exchange`);
  }
  authInFlight = true;
  const appIdHash = createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  let response;
  try {
  response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode }),
    signal: AbortSignal.timeout(15000)
  });
  } catch (error) {
    authInFlight = false;
    lastAuthError = String(error?.message || error).slice(0, 240);
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.s !== 'ok' || !body.access_token) {
    const message = String(body.message || body.error || `FYERS token exchange failed (HTTP ${response.status})`).slice(0, 240);
    lastAuthError = message;
    if (response.status === 429 || /1015|rate.?limit/i.test(message)) authRetryAfter = Date.now() + 15 * 60 * 1000;
    authInFlight = false;
    throw new Error(response.status === 429 ? `FYERS_AUTH_RATE_LIMIT_COOLDOWN: ${message}` : message);
  }
  accessToken = body.access_token;
  tokenReceivedAt = Date.now();
  lastAuthError = null;
  authRetryAfter = 0;
  authInFlight = false;
  return { connected: true, receivedAt: tokenReceivedAt };
}

export function getAuthStatus(now = Date.now()) {
  if (accessToken && tokenReceivedAt) {
    const istOffsetMs = 330 * 60 * 1000;
    const receivedIst = new Date(tokenReceivedAt + istOffsetMs);
    const receivedHour = receivedIst.getUTCHours();
    const receivedMinute = receivedIst.getUTCMinutes();
    let expiry = Date.UTC(receivedIst.getUTCFullYear(), receivedIst.getUTCMonth(), receivedIst.getUTCDate(), 6, 30) - istOffsetMs;
    if (receivedHour > 6 || (receivedHour === 6 && receivedMinute >= 30)) expiry += 24 * 60 * 60 * 1000;
    if (now >= expiry) {
      accessToken = null;
      tokenReceivedAt = null;
    }
  }
  return { status: accessToken ? 'AUTHENTICATED_FEED_NOT_CONNECTED' : now < authRetryAfter ? 'AUTH_RATE_LIMIT_COOLDOWN' : 'NOT_AUTHENTICATED', tokenStored: Boolean(accessToken), tokenReceivedAt, authRetryAfter: authRetryAfter || null, authInFlight, lastError: lastAuthError };
}

export function getAccessTokenForServer() { return accessToken; }
