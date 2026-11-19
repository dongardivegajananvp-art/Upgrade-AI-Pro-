import { detectNineStrategySetup } from './strategy-engine.js';

// Evaluate every official NSE F&O underlying independently from its own verified
// FYERS tick and cached completed candles. Missing data is explicitly BLOCKED.
export function evaluateRollingFnoUniverse({ universe = [], ticks = new Map(), fiveMinute = new Map(), daily = new Map(), fifteenMinute = new Map(), now = Date.now(), topGainers = [] } = {}) {
  const gainers = new Set(topGainers.map(item => item?.symbol).filter(Boolean));
  const evaluations = [];
  const candidates = [];
  for (const item of universe) {
    const symbol = item?.symbol;
    if (!symbol) continue;
    const tick = ticks.get(symbol) || null;
    const five = fiveMinute.get(symbol) || null;
    const day = daily.get(symbol) || null;
    const fifteen = fifteenMinute.get(symbol) || null;
    const result = detectNineStrategySetup({
      underlyingCandles: five?.candles || [], underlyingTick: tick,
      dailyCandles: day?.candles || [], fifteenMinuteCandles: fifteen?.candles || [],
      isTopGainer: gainers.has(symbol), researchEnabled: true, now
    });
    const row = {
      symbol, name: item.name || item.underlying || symbol,
      status: result.status, reason: result.reason || null,
      strategyLedger: result.strategyLedger || [],
      researchRanking: result.researchRanking || [],
      exchangeTime: tick?.exchangeTime || null,
      fresh: Boolean(tick && now - Number(tick.receivedAt) >= 0 && now - Number(tick.receivedAt) <= 10000 && now / 1000 - Number(tick.exchangeTime) >= -3 && now / 1000 - Number(tick.exchangeTime) <= 10)
    };
    evaluations.push(row);
    if (result.status === 'UNDERLYING_SETUP_CONFIRMED' && result.research?.status === 'COMPLETE') {
      candidates.push({ ...row, side: result.side, strategy: result.strategy, qualityScore: result.research.qualityScore, grade: result.research.grade, targetR: result.research.targetR, targetRationale: result.research.targetRationale, evidence: result.research.evidence, invalidation: result.research.invalidation });
    }
  }
  candidates.sort((a,b) => b.qualityScore - a.qualityScore || String(a.symbol).localeCompare(String(b.symbol)));
  return {
    status: candidates.length ? 'VERIFIED_CANDIDATES_AVAILABLE' : 'NO_VERIFIED_CANDIDATE',
    universeCount: evaluations.length,
    evaluatedCount: evaluations.filter(row => row.strategyLedger.some(entry => entry.status !== 'BLOCKED')).length,
    blockedCount: evaluations.filter(row => row.status === 'DATA_UNAVAILABLE_NO_TRADE').length,
    candidateCount: candidates.length,
    coverageMode: 'ROLLING_FO_UNIVERSE_NOT_SIMULTANEOUS',
    top3: candidates.slice(0,3).map((item,index)=>({...item,rank:index+1})),
    evaluations
  };
}
