export const SOCKET_SUBSCRIPTION_BATCH_SIZE = 10;
// Two paced batches complete a 20-symbol rotation while reducing subscription-control churn.
export const SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS = 30_000;

export function shouldAdvanceFnoRotation({ pendingCount = 0, cooldownActive = false } = {}) {
  return Number(pendingCount) === 0 && cooldownActive !== true;
}

export function canResumeSocketSubscriptionRecovery({ transportConnected = false, socketStatus = '', now = Date.now(), cooldownUntil = 0 } = {}) {
  return transportConnected === true && socketStatus === 'RATE_LIMITED_WAIT' &&
    Number.isFinite(Number(now)) && Number.isFinite(Number(cooldownUntil)) && Number(now) >= Number(cooldownUntil);
}

export function getSocketSubscriptionDelta(currentSymbols = [], desiredSymbols = []) {
  const current = [...new Set((Array.isArray(currentSymbols) ? currentSymbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const desired = [...new Set((Array.isArray(desiredSymbols) ? desiredSymbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    removed: current.filter(symbol => !desiredSet.has(symbol)),
    added: desired.filter(symbol => !currentSet.has(symbol))
  };
}

// Keep the currently selected option ahead of background F&O subscriptions.
// The caller still sends one symbol per paced batch; this only changes FIFO order.
export function resolveSelectedOptionOnUnderlyingChange(previousUnderlying, nextUnderlying, selectedOption = null) {
  return previousUnderlying === nextUnderlying ? selectedOption : null;
}

export function prioritizeSubscriptionQueue(pendingSymbols = [], prioritySymbols = null) {
  const queue = [...new Set((Array.isArray(pendingSymbols) ? pendingSymbols : [])
    .filter(symbol => typeof symbol === 'string' && symbol))];
  const requested = Array.isArray(prioritySymbols) ? prioritySymbols : [prioritySymbols];
  const priorities = [...new Set(requested.filter(symbol => typeof symbol === 'string' && symbol && queue.includes(symbol)))];
  if (!priorities.length) return queue;
  const prioritySet = new Set(priorities);
  return [...priorities, ...queue.filter(symbol => !prioritySet.has(symbol))];
}

export function splitSubscriptionBatches(symbols = [], batchSize = 4) {
  const size = Math.max(1, Math.floor(Number(batchSize) || 4));
  const unique = [...new Set((Array.isArray(symbols) ? symbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const batches = [];
  for (let i = 0; i < unique.length; i += size) batches.push(unique.slice(i, i + size));
  return batches;
}

export function buildSetupEvaluationSubscriptionSymbols(pins = []) {
  const entries=pins instanceof Map?[...pins.values()]:Array.isArray(pins)?pins:[];
  return [...new Set(entries.flatMap(entry=>Array.isArray(entry)?entry:Array.isArray(entry?.symbols)?entry.symbols:[])
    .filter(symbol=>typeof symbol==='string'&&/^NSE:[A-Z0-9&._-]+$/.test(symbol)))];
}

export function buildDesiredSocketSubscriptions(indexSymbols = [], activeSymbols = [], selectedOptionSymbol = null) {
  const indices = Array.isArray(indexSymbols) ? indexSymbols : [...(indexSymbols || [])];
  const active = Array.isArray(activeSymbols) ? activeSymbols : [];
  const option = typeof selectedOptionSymbol === 'string' && selectedOptionSymbol ? [selectedOptionSymbol] : [];
  return [...new Set([...indices, ...active, ...option].filter(symbol => typeof symbol === 'string' && symbol))];
}

// Keep index subscriptions available off-session, but only subscribe rotating
// underlyings and the selected option when the NSE session/feed is confirmed.
export function buildSessionSocketSubscriptions(indexSymbols = [], activeSymbols = [], selectedOptionSymbol = null, sessionReady = false) {
  return buildDesiredSocketSubscriptions(
    indexSymbols,
    sessionReady ? activeSymbols : [],
    sessionReady ? selectedOptionSymbol : null
  );
}


export function buildSocketSubscriptionDiagnostics({ desired = [], sentToSdk = [], pending = [] } = {}) {
  const normalize = values => [...new Set((Array.isArray(values) ? values : [])
    .filter(symbol => typeof symbol === 'string' && symbol))];
  const desiredSymbols = normalize(desired);
  const sentSymbols = normalize(sentToSdk);
  const pendingSymbols = normalize(pending);
  return {
    desiredCount: desiredSymbols.length,
    sentToSdkCount: sentSymbols.length,
    pendingCount: pendingSymbols.length,
    desiredSymbols,
    sentToSdkSymbols: sentSymbols,
    pendingSymbols,
    // The FYERS SDK's generic subscription ACK is not symbol-specific; do not
    // mislabel a local SDK send as an exchange-confirmed subscription.
    confirmation: 'SDK_SEND_STATE_ONLY'
  };
}


export function pruneSymbolMap(map, allowedSymbols = [], maxSize = 300) {
  if (!(map instanceof Map)) return 0;
  const allowed = new Set((Array.isArray(allowedSymbols) ? allowedSymbols : [])
    .filter(symbol => typeof symbol === 'string' && symbol));
  for (const key of map.keys()) if (!allowed.has(key)) map.delete(key);
  const limit = Math.max(1, Math.floor(Number(maxSize) || 300));
  while (map.size > limit) map.delete(map.keys().next().value);
  return map.size;
}

// FYERS subscription ACKs are generic; they do not identify accepted symbols.
export function isGenericSubscriptionAck(item) {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item) && item.type === 'sub' && Number(item.code) === 200);
}
// FYERS Node DataSocket reconnect policy must be configured before opening the
// transport. Keep this ordering in one testable helper so a disconnect cannot
// leave the SDK running without its reconnect handler.
export function connectWithAutoReconnect(socket, retryCount = 10) {
  if (!socket || typeof socket.autoreconnect !== 'function' || typeof socket.connect !== 'function') {
    throw new TypeError('FYERS DataSocket must expose autoreconnect() and connect()');
  }
  socket.autoreconnect(Math.min(50, Math.max(1, Math.floor(Number(retryCount) || 10))));
  socket.connect();
  return true;
}
export function formatSocketCloseDetail(details = []) {
  if (!Array.isArray(details) || details.length === 0) return null;
  const parts = details.map(value => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).filter(Boolean);
  return parts.join(' | ').slice(0, 240) || null;
}


// Candle observations must cover every actively subscribed F&O scanner candidate,
// including pinned Top Gainers outside the current 20-symbol rotation slice.
export function buildFnoCandleObservationSymbols(activeSymbols = [], pinnedTopGainerSymbols = [], selectedUnderlyingSymbol = null) {
  const values = [
    ...(Array.isArray(activeSymbols) ? activeSymbols : []),
    ...(Array.isArray(pinnedTopGainerSymbols) ? pinnedTopGainerSymbols : []),
    selectedUnderlyingSymbol
  ];
  return [...new Set(values.filter(symbol => typeof symbol === 'string' && /^NSE:[A-Z0-9&._-]+-EQ$/.test(symbol)))];
}


// Produce one serialized WebSocket control operation; removals take priority
// so a rotating slice frees its old slots before new symbols are subscribed.
export function buildNextSocketSubscriptionOperation(pendingUnsubscribeSymbols = [], pendingSubscribeSymbols = [], batchSize = SOCKET_SUBSCRIPTION_BATCH_SIZE) {
  const unsubscribe = [...new Set((Array.isArray(pendingUnsubscribeSymbols) ? pendingUnsubscribeSymbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const subscribe = [...new Set((Array.isArray(pendingSubscribeSymbols) ? pendingSubscribeSymbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const type = unsubscribe.length ? 'unsubscribe' : subscribe.length ? 'subscribe' : null;
  if (!type) return null;
  const source = type === 'unsubscribe' ? unsubscribe : subscribe;
  return { type, symbols: source.slice(0, Math.max(1, Math.floor(Number(batchSize) || SOCKET_SUBSCRIPTION_BATCH_SIZE))) };
}

// Requeue only the operation rejected by FYERS 1015. A failed unsubscribe
// must remain locally subscribed; a failed subscribe must remain pending.
export function requeueRejectedSocketSubscriptionOperation(operation, pendingUnsubscribeSymbols = [], pendingSubscribeSymbols = []) {
  const unsubscribe = [...(Array.isArray(pendingUnsubscribeSymbols) ? pendingUnsubscribeSymbols : [])];
  const subscribe = [...(Array.isArray(pendingSubscribeSymbols) ? pendingSubscribeSymbols : [])];
  const symbols = [...new Set((Array.isArray(operation?.symbols) ? operation.symbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  if (operation?.type === 'unsubscribe') return { pendingUnsubscribeSymbols: [...new Set([...symbols, ...unsubscribe])], pendingSubscribeSymbols: [...new Set(subscribe)] };
  if (operation?.type === 'subscribe') return { pendingUnsubscribeSymbols: [...new Set(unsubscribe)], pendingSubscribeSymbols: [...new Set([...symbols, ...subscribe])] };
  return { pendingUnsubscribeSymbols: [...new Set(unsubscribe)], pendingSubscribeSymbols: [...new Set(subscribe)] };
}
