import { isValidOhlcvCandle } from './candle-validation.js';
import { detectNineStrategySetup, STRATEGIES } from './strategy-engine.js';

const NSE_OPEN_MINUTE = 555;
const NSE_CLOSE_MINUTE = 930;
const FIVE_MINUTES = 300;
const IST_OFFSET_SECONDS = 19800;

function istDayKey(epochSeconds) {
  return new Date((Number(epochSeconds) + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

function validateSeries(rows, label, intervalSeconds) {
  if (!Array.isArray(rows) || rows.length === 0) return label + ' FYERS historical candles are missing';
  let previous = 0;
  for (const candle of rows) {
    if (!isValidOhlcvCandle(candle) || !Number.isFinite(Number(candle.volume)) || Number(candle.volume) < 0) {
      return label + ' contains a malformed OHLCV candle';
    }
    const time = Number(candle.time);
    if (time <= previous) return label + ' candle timestamps must be strictly increasing and unique';
    const date = new Date((time + IST_OFFSET_SECONDS) * 1000);
    const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
    if (intervalSeconds === FIVE_MINUTES &&
        (minute < NSE_OPEN_MINUTE || minute >= NSE_CLOSE_MINUTE || (minute - NSE_OPEN_MINUTE) % 5 !== 0)) {
      return label + ' contains a candle outside regular NSE 5-minute session boundaries';
    }
    previous = time;
  }
  return null;
}

function sessionWindowIsContinuous(rows) {
  if (rows.length < 2) return true;
  return rows.every((row, index) => {
    if (index === 0) return true;
    const previous = rows[index - 1];
    const delta = Number(row.time) - Number(previous.time);
    if (delta === FIVE_MINUTES) return true;
    const prevDate = new Date((Number(previous.time) + IST_OFFSET_SECONDS) * 1000);
    const currDate = new Date((Number(row.time) + IST_OFFSET_SECONDS) * 1000);
    const prevMinute = prevDate.getUTCHours() * 60 + prevDate.getUTCMinutes();
    const currMinute = currDate.getUTCHours() * 60 + currDate.getUTCMinutes();
    return prevMinute === NSE_CLOSE_MINUTE - 5 && currMinute === NSE_OPEN_MINUTE &&
      currDate.toISOString().slice(0, 10) > prevDate.toISOString().slice(0, 10);
  });
}

/**
 * Replays completed FYERS 5-minute underlying candles through the exact
 * nine-strategy detector. This is signal research only: it intentionally does
 * not invent option quotes, fills, slippage, contract history, or P&L.
 */
export function runHistoricalSignalReplay({
  symbol,
  fiveMinuteCandles = [],
  dailyCandles = [],
  topGainerMembership = [],
  dataProvenance,
  startTime = null,
  endTime = null
} = {}) {
  const fail = reason => ({
    status: 'DATA_UNAVAILABLE',
    mode: 'HISTORICAL_SIGNAL_REPLAY',
    actionable: false,
    reason,
    signals: [],
    summary: Object.fromEntries(STRATEGIES.map(strategy => [strategy, 0])),
    strategyDiagnostics: Object.fromEntries(STRATEGIES.map(strategy => [strategy, { blocked:0, rejected:0, detected:0 }])),
    tradePerformance: null
  });

  if (dataProvenance !== 'FYERS_HISTORICAL_API') {
    return fail('Only explicitly identified FYERS historical API data is accepted; sample/synthetic data is not accepted');
  }
  if (typeof symbol !== 'string' || !/^NSE:[A-Z0-9&._-]{1,48}$/.test(symbol)) {
    return fail('A valid NSE cash/equity symbol is required');
  }
  const fiveMinuteError = validateSeries(fiveMinuteCandles, '5-minute', FIVE_MINUTES);
  if (fiveMinuteError) return fail(fiveMinuteError);
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 50) {
    return fail('At least 50 FYERS daily candles are required for the nine-strategy warm-up and daily trend gate');
  }
  const dailyError = validateSeries(dailyCandles, 'Daily', 86400);
  if (dailyError) return fail(dailyError);
  if (!sessionWindowIsContinuous(fiveMinuteCandles)) {
    return fail('5-minute history has an unexplained gap or out-of-order session transition; replay is stopped');
  }
  const start = startTime == null ? Number(fiveMinuteCandles[0].time) : Number(startTime);
  const end = endTime == null ? Number(fiveMinuteCandles.at(-1).time) : Number(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return fail('Replay start/end timestamps are invalid');
  }
  if (!Array.isArray(topGainerMembership)) {
    return fail('Historical Top Gainer membership must be supplied as timestamped verified snapshots');
  }
  const membershipByTime = new Map();
  for (const snapshot of topGainerMembership) {
    if (!snapshot || !Number.isFinite(Number(snapshot.time)) || !Array.isArray(snapshot.symbols)) {
      return fail('Historical Top Gainer snapshot is malformed; membership cannot be inferred from today\'s gainers');
    }
    membershipByTime.set(Number(snapshot.time), new Set(snapshot.symbols.map(value => String(value).toUpperCase())));
  }

  const summary = Object.fromEntries(STRATEGIES.map(strategy => [strategy, 0]));
  const strategyDiagnostics = Object.fromEntries(STRATEGIES.map(strategy => [strategy, { blocked:0, rejected:0, detected:0 }]));
  let topGainerSnapshotsMatched = 0;
  let topGainerSnapshotsMissing = 0;
  const signals = [];
  const seen = new Set();
  let evaluatedCandles = 0;
  let skippedWarmupCandles = 0;
  for (let index = 0; index < fiveMinuteCandles.length; index += 1) {
    const candle = fiveMinuteCandles[index];
    const candleTime = Number(candle.time);
    if (candleTime < start || candleTime > end) continue;
    const prefix = fiveMinuteCandles.slice(0, index + 1);
    const asOf = candleTime + FIVE_MINUTES;
    const replayDaily = dailyCandles.filter(row => istDayKey(row.time) < istDayKey(asOf));
    if (prefix.length < 2 || replayDaily.length < 50) {
      skippedWarmupCandles += 1;
      continue;
    }
    evaluatedCandles += 1;
    const members = membershipByTime.get(candleTime);
    if (members) topGainerSnapshotsMatched += 1;
    else topGainerSnapshotsMissing += 1;
    const isTopGainer = Boolean(members && members.has(symbol.toUpperCase()));
    const result = detectNineStrategySetup({
      underlyingCandles: prefix,
      underlyingTick: null,
      dailyCandles: replayDaily,
      isTopGainer,
      now: asOf * 1000,
      historicalAsOf: asOf,
      maxCandleAgeSeconds: 0
    });
    for (const row of result.strategyLedger || []) {
      const diagnostic = strategyDiagnostics[row.strategy];
      if (diagnostic && Object.prototype.hasOwnProperty.call(diagnostic, String(row.status || '').toLowerCase())) {
        diagnostic[String(row.status).toLowerCase()] += 1;
      }
    }
    if (result.status !== 'UNDERLYING_SETUP_CONFIRMED') continue;
    const key = result.strategy + ':' + Number(result.confirmedAt);
    if (seen.has(key)) continue;
    seen.add(key);
    summary[result.strategy] += 1;
    signals.push({
      symbol,
      strategy: result.strategy,
      side: result.side,
      confirmedAt: Number(result.confirmedAt),
      evaluatedAt: asOf,
      underlyingClose: Number(candle.close),
      breakoutLevel: Number(result.breakoutLevel),
      confirmation: result.breakoutConfirmation || null,
      dataMode: 'FYERS_HISTORICAL_CANDLE_REPLAY',
      optionExecution: 'NOT_SIMULATED',
      entry: null,
      stopLoss: null,
      target: null,
      pnl: null
    });
  }

  return {
    status: topGainerSnapshotsMissing > 0 ? 'PARTIAL' : 'COMPLETE',
    mode: 'HISTORICAL_SIGNAL_REPLAY',
    actionable: false,
    symbol,
    source: 'FYERS_HISTORICAL_API',
    interval: '5m',
    startTime: start,
    endTime: end,
    evaluatedCandles,
    skippedWarmupCandles,
    topGainerCoverage: {
      status: topGainerSnapshotsMissing === 0 ? 'COMPLETE' : 'NOT_EVALUATED',
      matchedSnapshots: topGainerSnapshotsMatched,
      missingSnapshots: topGainerSnapshotsMissing,
      reason: topGainerSnapshotsMissing > 0 ? 'Timestamp-matched historical Top Gainer membership snapshots are missing; this strategy cannot be evaluated for those candles' : null
    },
    signalCount: signals.length,
    signals,
    summary,
    strategyDiagnostics,
    tradePerformance: null,
    limitations: [
      'Historical underlying strategy signals only; this is not a full option-trade backtest.',
      'Historical option contract identity, option candles, quote/fill timing, spread, slippage and brokerage are not simulated.',
      'No entry, stop, target, win rate, profit factor or P&L is inferred from underlying candles.',
      'Top Gainer strategy is evaluated only where a timestamp-matched historical membership snapshot exists.',
      'The replay uses only candles available up to each evaluation timestamp to prevent future-candle look-ahead.'
    ]
  };
}
