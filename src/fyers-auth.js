import { createHash, randomBytes } from 'node:crypto';

const AUTH_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
const TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';
const pendingStates = new Map();
let accessToken = null;
let tokenReceivedAt = null;
let lastAuthError = null;

export function createLoginUrl({ appId, redirectUri, now = Date.now() }) {
  if (!appId || !redirectUri) throw new Error('FYERS_APP_ID and FYERS_REDIRECT_URI are required');
  const state = randomBytes(24).toString('hex');
  pendingStates.set(state, now + 10 * 60 * 1000);
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

export function consumeLoginState(state, now = Date.now()) {
  if (typeof state !== 'string' || !state) return false;
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  return Number.isFinite(expiry) && expiry >= now;
}

export async function exchangeAuthCode({ appId, appSecret, authCode }) {
  if (!appId || !appSecret || !authCode) throw new Error('FYERS OAuth configuration or authorization code is missing');
  const appIdHash = createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.s !== 'ok' || !body.access_token) {
    const message = String(body.message || body.error || `FYERS token exchange failed (HTTP ${response.status})`).slice(0, 240);
    lastAuthError = message;
    throw new Error(message);
  }
  accessToken = body.access_token;
  tokenReceivedAt = Date.now();
  lastAuthError = null;
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
  return { status: accessToken ? 'AUTHENTICATED_FEED_NOT_CONNECTED' : 'NOT_AUTHENTICATED', tokenStored: Boolean(accessToken), tokenReceivedAt, lastError: lastAuthError };
}

export function getAccessTokenForServer() { return accessToken; }
