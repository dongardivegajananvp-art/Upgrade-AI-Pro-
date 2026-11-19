const FO_MASTER = 'https://public.fyers.in/sym_details/NSE_FO_sym_master.json';
const CM_MASTER = 'https://public.fyers.in/sym_details/NSE_CM_sym_master.json';
let cachedDate = null;
let cachedUniverse = null;
let cachedFoRows = null;

function rowsOf(master) {
  if (Array.isArray(master)) return master;
  if (master && typeof master === 'object') return Object.entries(master).map(([key, value]) => ({ ...value, __masterKey: key }));
  return [];
}
function dateKey(now) {
  return new Date(now + 19800000).toISOString().slice(0, 10);
}
function expiryEpoch(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}
function expiryDay(value) {
  const epoch = expiryEpoch(value);
  return epoch ? new Date(epoch * 1000 + 19800000).toISOString().slice(0, 10) : '';
}
function normaliseUnderlying(value) {
  return String(value || '').trim().toUpperCase()
    .replace(/^NSE:/, '')
    .replace(/-EQ$/, '')
    .replace(/-INDEX$/, '');
}
export function buildFnoEquityUniverse(foMaster, cmMaster, now = Date.now()) {
  const today = dateKey(now);
  const foRows = rowsOf(foMaster);
  const cmRows = rowsOf(cmMaster);
  if (!foRows.length || !cmRows.length) throw new Error('Official FYERS NSE symbol masters are empty or malformed');
  const activeUnderlyings = new Set();
  let activeOptionContracts = 0;
  for (const row of foRows) {
    if (!row || !['CE', 'PE'].includes(String(row.optType || '').toUpperCase())) continue;
    if (row.tradeStatus !== undefined && Number(row.tradeStatus) !== 1) continue;
    const expiry = expiryDay(row.expiryDate);
    const underlying = normaliseUnderlying(row.underSym);
    if (expiry && expiry >= today && underlying) {
      activeOptionContracts++;
      activeUnderlyings.add(underlying);
    }
  }
  const byUnderlying = new Map();
  for (const row of cmRows) {
    if (!row) continue;
    const ticker = String(row.symTicker || row.__masterKey || '').trim();
    if (!/^NSE:[A-Z0-9&._-]+-EQ$/.test(ticker)) continue;
    if (row.tradeStatus !== undefined && Number(row.tradeStatus) !== 1) continue;
    const underlyingFromTicker = normaliseUnderlying(ticker);
    const aliases = [underlyingFromTicker, normaliseUnderlying(row.exSymName), normaliseUnderlying(row.exSymbol)];
    const mapped = { underlying: underlyingFromTicker, symbol: ticker, fyToken: String(row.fyToken || '').trim(), name: String(row.symDetails || row.exSymName || underlyingFromTicker) };
    if (!mapped.fyToken) continue;
    for (const alias of aliases) if (alias && !byUnderlying.has(alias)) byUnderlying.set(alias, mapped);
  }
  const universe = [];
  for (const underlying of activeUnderlyings) {
    const row = byUnderlying.get(underlying);
    if (!row) continue;
    universe.push({ ...row, underlying });
  }
  universe.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!universe.length) throw new Error('No NSE cash equities could be mapped to active F&O underlyings from the official masters');
  return {
    date: today, universe,
    diagnostics: {
      foMasterRows: foRows.length, cmMasterRows: cmRows.length,
      activeOptionContracts, activeUnderlyingCount: activeUnderlyings.size,
      mappedUnderlyingCount: universe.length
    }
  };
}
export async function loadFnoEquityUniverse(now = Date.now()) {
  const today = dateKey(now);
  if (cachedDate === today && cachedUniverse) return { date: today, universe: cachedUniverse, cached: true };
  const [foResponse, cmResponse] = await Promise.all([
    fetch(FO_MASTER, { signal: AbortSignal.timeout(15000) }),
    fetch(CM_MASTER, { signal: AbortSignal.timeout(15000) })
  ]);
  if (!foResponse.ok || !cmResponse.ok) throw new Error('Official FYERS NSE symbol-master download failed');
  const [foMaster, cmMaster] = await Promise.all([foResponse.json(), cmResponse.json()]);
  const result = buildFnoEquityUniverse(foMaster, cmMaster, now);
  cachedDate = today;
  cachedUniverse = result.universe;
  cachedFoRows = rowsOf(foMaster);
  return { ...result, cached: false };
}
export function getVerifiedOptionContract(symbol, now = Date.now()) {
  if (!cachedFoRows) throw new Error('Official FYERS NSE F&O symbol master is not loaded');
  const row = cachedFoRows.find(item => String(item?.symTicker || item?.__masterKey || '') === String(symbol || ''));
  if (!row || !['CE', 'PE'].includes(String(row.optType || '').toUpperCase())) throw new Error('Option contract is not present in the official FYERS NSE F&O symbol master');
  if (row.tradeStatus !== undefined && Number(row.tradeStatus) !== 1) throw new Error('Option contract is inactive in the official FYERS master');
  const expiry = expiryEpoch(row.expiryDate);
  const expiryDate = expiryDay(row.expiryDate);
  const lotSize = Number(row.minLotSize);
  const tickSize = Number(row.tickSize);
  const strike = Number(row.strikePrice);
  if (!(expiryDate >= dateKey(now)) || !(lotSize > 0) || !(tickSize > 0) || !(strike >= 0)) throw new Error('Option contract expiry, lot size, strike or tick size is invalid');
  return {
    symbol: String(row.symTicker || row.__masterKey), side: String(row.optType).toUpperCase(),
    expiry, strike, lotSize, tickSize, fyToken: String(row.fyToken || '')
  };
}
