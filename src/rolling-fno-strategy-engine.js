import { detectNineStrategySetup } from './strategy-engine.js';

// Evaluate every official NSE F&O underlying independently from its own verified
// FYERS tick and cached completed candles. Missing data is explicitly BLOCKED.
export function evaluateRollingFnoUniverse({ universe = [], ticks = new Map(), fiveMinute = new Map(), fifteenMinute = new Map(), now = Date.now(), topGainers = [] } = {}) {
  const gainers = new Set(topGainers.map(item => item?.symbol).filter(Boolean));
  const evaluations = [];
  const candidates = [];
  for (const item of universe) {
    const symbol = item?.symbol;
    if (!symbol) continue;
    const tick = ticks.get(symbol) || null;
    const five = fiveMinute.get(symbol) || null;
    const fifteen = fifteenMinute.get(symbol) || null;
    const result = detectNineStrategySetup({
      underlyingCandles: five?.candles || [], underlyingTick: tick,
      dailyCandles: [], fifteenMinuteCandles: fifteen?.candles || [],
      isTopGainer: gainers.has(symbol), researchEnabled: false, now
    });
    const row = {
      symbol, name: item.name || item.underlying || symbol,
      status: result.status, reason: result.reason || null,
      strategyLedger: result.strategyLedger || [],
      researchRanking: result.researchRanking || [],
      exchangeTime: tick?.exchangeTime || null,
      fresh: Boolean(tick && now - Number(tick.receivedAt) >= 0 && now - Number(tick.receivedAt) <= 10000 && now / 1000 - Number(tick.exchangeTime) >= -3 && true && Number(tick.receivedAt) - Number(tick.exchangeTime) * 1000 >= 0 && Number(tick.receivedAt) - Number(tick.exchangeTime) * 1000 <= 5000)
    };
    evaluations.push(row);
    if (result.status === 'UNDERLYING_SETUP_CONFIRMED' && row.fresh) {
      candidates.push({ ...row, side: result.side, strategy: result.strategy,
        qualityScore: null, grade: 'PRICE_SETUP', targetR: 2,
        targetRationale: 'Minimum 2R is calculated only after official option verification',
        evidence: ['Fresh FYERS underlying tick', 'Completed 5-minute strategy price structure'],
        invalidation: 'Re-evaluate the strategy structure on the next completed 5-minute candle' });
    }
  }
  candidates.sort((a,b) => b.qualityScore - a.qualityScore || String(a.symbol).localeCompare(String(b.symbol)));
  return {
    status: candidates.length ? 'PRICE_SETUPS_AVAILABLE' : 'NO_PRICE_SETUP',
    universeCount: evaluations.length,
    evaluatedCount: evaluations.filter(row => row.strategyLedger.some(entry => entry.status !== 'BLOCKED')).length,
    blockedCount: evaluations.filter(row => row.status === 'DATA_UNAVAILABLE_NO_TRADE').length,
    candidateCount: candidates.length,
    coverageMode: 'ROLLING_FO_UNIVERSE_NOT_SIMULTANEOUS',
    top3: candidates.slice(0,3).map((item,index)=>({...item,rank:index+1})),
    evaluations
  };
}
