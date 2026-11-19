const FO_MASTER = 'https://public.fyers.in/sym_details/NSE_FO_sym_master.json';
const CM_MASTER = 'https://public.fyers.in/sym_details/NSE_CM_sym_master.json';
let cachedDate = null;
let cachedUniverse = null;

function rowsOf(master) {
  if (Array.isArray(master)) return master;
  if (master && typeof master === 'object') return Object.values(master);
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
export function buildFnoEquityUniverse(foMaster, cmMaster, now = Date.now()) {
  const today = dateKey(now);
  const foRows = rowsOf(foMaster);
  const cmRows = rowsOf(cmMaster);
  if (!foRows.length || !cmRows.length) throw new Error('Official FYERS NSE symbol masters are empty or malformed');
  const activeUnderlyings = new Set();
  for (const row of foRows) {
    if (!row || !['CE', 'PE'].includes(String(row.optType || '').toUpperCase())) continue;
    const expiry = expiryEpoch(row.expiryDate);
    const underlying = String(row.underSym || '').trim().toUpperCase();
    if (expiry > now / 1000 && underlying) activeUnderlyings.add(underlying);
  }
  const byUnderlying = new Map();
  for (const row of cmRows) {
    if (!row) continue;
    const name = String(row.exSymName || '').trim().toUpperCase();
    const ticker = String(row.symTicker || '').trim();
    if (!name || !ticker.startsWith('NSE:') || !ticker.endsWith('-EQ')) continue;
    if (!byUnderlying.has(name)) byUnderlying.set(name, row);
  }
  const universe = [];
  for (const underlying of activeUnderlyings) {
    const row = byUnderlying.get(underlying);
    if (!row) continue;
    const symbol = String(row.symTicker).trim();
    const fyToken = String(row.fyToken || '').trim();
    if (!/^NSE:[A-Z0-9&._-]+-EQ$/.test(symbol) || !fyToken) continue;
    universe.push({ underlying, symbol, fyToken, name: String(row.symDetails || underlying) });
  }
  universe.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!universe.length) throw new Error('No NSE cash equities could be mapped to active F&O underlyings from the official masters');
  return { date: today, universe };
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
  return { ...result, cached: false };
}
