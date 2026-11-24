import { runHistoricalSignalReplay } from './backtest-engine.js';

const SYMBOL_PATTERN = /^NSE:[A-Z0-9&._-]{1,48}-EQ$/;
const DAY_MS = 86400000;
const STRATEGY_IDS = [
  'EMA20_EMA50_TREND', 'TOP_GAINER_MOMENTUM_BREAKOUT', 'DAILY_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST', 'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',
  'BULLISH_CONTINUATION', 'BEARISH_CONTINUATION', 'FLAG_BREAKOUT_VOLUME',
  'OPENING_RANGE_BREAKOUT'
];

function istDateKey(epochMs) {
  return new Date(Number(epochMs) + 19800000).toISOString().slice(0, 10);
}
function shiftCalendarDays(epochMs, days) {
  return Number(epochMs) + Number(days) * DAY_MS;
}

/**
 * Process-local, read-only historical replay coordinator. It never places
 * orders and accepts only official-master NSE F&O equity symbols plus data
 * explicitly tagged as FYERS_HISTORICAL_API by the injected fetcher.
 */
export function createHistoricalFnoBacktestRunner({
  fetchHistory,
  replay = runHistoricalSignalReplay,
  now = () => Date.now(),
  maxSymbols = 300,
  maxStoredSignals = 5000
} = {}) {
  if (typeof fetchHistory !== 'function') throw new TypeError('A FYERS historical-data fetcher is required');
  let activeJob = null;
  const jobs = new Map();

  function snapshot(job) {
    return {
      id: job.id,
      status: job.status,
      mode: 'FNO_STOCKS_3_MONTH_HISTORICAL_SIGNAL_REPLAY',
      source: 'FYERS_HISTORICAL_API_ONLY',
      actionable: false,
      ordersEnabled: false,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      requestedStartDate: job.requestedStartDate,
      requestedEndDate: job.requestedEndDate,
      warmupStartDate: job.warmupStartDate,
      universeCount: job.universeCount,
      processedCount: job.processedCount,
      completedCount: job.completedCount,
      blockedCount: job.blockedCount,
      signalCount: job.signalCount,
      strategySummary: { ...job.strategySummary },
      strategyDiagnostics: JSON.parse(JSON.stringify(job.strategyDiagnostics)),
      currentSymbol: job.currentSymbol,
      storedSignalCount: job.signals.length,
      signalsTruncated: job.signalCount > job.signals.length,
      estimatedMinimumMinutesAtGuardedBudget: Math.ceil((job.universeCount * 2) / 3),
      signals: job.signals.slice(),
      failures: job.failures.slice(0, 100),
      failureCount: job.failureCount,
      nextIndex: job.nextIndex,
      pauseReason: job.pauseReason || null,
      limitations: [
        'This run evaluates underlying 5-minute strategy signals only; it is not an option-trade P&L backtest.',
        'Historical option contracts, option OHLCV, quote/fill timing, spread, slippage and brokerage are not simulated.',
        'Entry, stop-loss, target, win rate, profit factor and P&L are not inferred.',
        'Historical Top Gainer membership is unavailable unless timestamp-matched official snapshots are supplied; current gainers are never backfilled.',
        'Job progress is process-local and is lost if the service restarts.'
      ]
    };
  }

  async function execute(job) {
    job.status = 'RUNNING';
    job.pauseReason = null;
    while (job.nextIndex < job.universe.length) {
      if (job.cancelRequested) {
        job.status = 'CANCELLED';
        break;
      }
      const item = job.universe[job.nextIndex];
      job.currentSymbol = item.symbol;
      let pause = false;
      try {
        const data = await fetchHistory({
          symbol: item.symbol,
          startTime: job.fiveMinuteStartTime,
          dailyStartTime: job.warmupStartTime,
          endTime: job.endTime
        });
        if (!data || data.dataProvenance !== 'FYERS_HISTORICAL_API') {
          throw new Error('History fetcher did not attest FYERS_HISTORICAL_API provenance');
        }
        const result = replay({
          symbol: item.symbol,
          fiveMinuteCandles: data.fiveMinuteCandles,
          dailyCandles: data.dailyCandles,
          topGainerMembership: data.topGainerMembership || [],
          dataProvenance: data.dataProvenance,
          startTime: job.startTime,
          endTime: job.endTime
        });
        if (result.status !== 'COMPLETE' || result.actionable !== false) {
          job.blockedCount += 1;
          job.failures.push({ symbol: item.symbol, status: result.status || 'DATA_UNAVAILABLE', reason: result.reason || 'Replay did not complete safely' });
          job.failureCount += 1;
        } else {
          job.completedCount += 1;
          job.signalCount += Number(result.signalCount) || 0;
          for (const [strategy, count] of Object.entries(result.summary || {})) {
            job.strategySummary[strategy] = (job.strategySummary[strategy] || 0) + Number(count || 0);
          }
          for (const [strategy, counts] of Object.entries(result.strategyDiagnostics || {})) {
            if (!job.strategyDiagnostics[strategy]) continue;
            for (const [status, count] of Object.entries(counts || {})) {
              if (Object.prototype.hasOwnProperty.call(job.strategyDiagnostics[strategy], status)) {
                job.strategyDiagnostics[strategy][status] += Number(count || 0);
              }
            }
          }
          for (const signal of result.signals || []) {
            if (job.signals.length < job.maxStoredSignals) job.signals.push(signal);
          }
        }
      } catch (error) {
        const reason = String(error?.message || error).slice(0, 180);
        if (/429|1015|cooldown|rate.?limit|authentication is not active|HTTP 401|authenticate the user/i.test(reason)) {
          job.status = 'PAUSED_UPSTREAM_GUARD';
          job.pauseReason = reason;
          pause = true;
        } else {
          job.blockedCount += 1;
          job.failureCount += 1;
          job.failures.push({ symbol: item.symbol, status: 'DATA_UNAVAILABLE', reason });
        }
      }
      if (pause) break;
      job.processedCount += 1;
      job.nextIndex += 1;
    }
    if (job.status !== 'PAUSED_UPSTREAM_GUARD' && job.status !== 'CANCELLED') {
      job.status = job.blockedCount ? (job.completedCount ? 'PARTIAL' : 'DATA_UNAVAILABLE') : 'COMPLETE';
      job.completedAt = new Date(now()).toISOString();
    }
    job.currentSymbol = null;
    if (activeJob === job) activeJob = null;
  }

  return {
    start({ universe, months = 3 } = {}) {
      if (activeJob && ['QUEUED', 'RUNNING'].includes(activeJob.status)) {
        return { accepted: false, reason: 'A historical F&O backtest is already running', job: snapshot(activeJob) };
      }
      if (!Array.isArray(universe) || universe.length === 0 || universe.length > maxSymbols) {
        return { accepted: false, reason: 'A non-empty official FYERS NSE F&O equity universe within the configured symbol cap is required' };
      }
      const unique = new Map();
      for (const item of universe) {
        const symbol = String(item?.symbol || '').trim().toUpperCase();
        if (SYMBOL_PATTERN.test(symbol)) unique.set(symbol, { ...item, symbol });
      }
      const symbols = [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
      if (!symbols.length) return { accepted: false, reason: 'Official universe contains no valid NSE F&O equity symbols' };
      const monthCount = Number(months);
      if (monthCount !== 3) return { accepted: false, reason: 'This run is configured for exactly three calendar months' };
      const endTime = Math.floor(Number(now()) / 1000);
      const endDate = new Date(Number(now()));
      const startDate = new Date(endDate);
      startDate.setMonth(startDate.getMonth() - 3);
      const startTime = Math.floor(startDate.getTime() / 1000);
      const warmupStartTime = Math.floor(shiftCalendarDays(startDate.getTime(), -120) / 1000);
      const job = {
        id: 'fno3m-' + endTime,
        status: 'QUEUED',
        startedAt: new Date(now()).toISOString(),
        completedAt: null,
        requestedStartDate: istDateKey(startDate.getTime()),
        requestedEndDate: istDateKey(endDate.getTime()),
        warmupStartDate: istDateKey(shiftCalendarDays(startDate.getTime(), -120)),
        startTime,
        endTime,
        warmupStartTime,
        fiveMinuteStartTime: Math.floor(shiftCalendarDays(startDate.getTime(), -5) / 1000),
        universe: symbols,
        universeCount: symbols.length,
        processedCount: 0,
        completedCount: 0,
        blockedCount: 0,
        signalCount: 0,
        strategySummary: Object.fromEntries(STRATEGY_IDS.map(strategy => [strategy, 0])),
        strategyDiagnostics: Object.fromEntries(STRATEGY_IDS.map(strategy => [strategy, { blocked:0, rejected:0, detected:0 }])),
        signals: [],
        failures: [],
        failureCount: 0,
        maxStoredSignals,
        cancelRequested: false,
        nextIndex: 0,
        pauseReason: null,
        currentSymbol: null
      };
      jobs.set(job.id, job);
      activeJob = job;
      // Yield before beginning upstream history calls so the HTTP start response
      // is returned immediately. Each symbol is fetched sequentially.
      setImmediate(() => { void execute(job); });
      return { accepted: true, job: snapshot(job) };
    },
    get(jobId) {
      const job = jobs.get(String(jobId || ''));
      return job ? snapshot(job) : null;
    },
    resume(jobId) {
      const job = jobs.get(String(jobId || ''));
      if (!job || job.status !== 'PAUSED_UPSTREAM_GUARD' || activeJob) return false;
      job.status = 'QUEUED';
      activeJob = job;
      setImmediate(() => { void execute(job); });
      return true;
    },
    cancel(jobId) {
      const job = jobs.get(String(jobId || ''));
      if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return false;
      job.cancelRequested = true;
      return true;
    },
    active() {
      return activeJob ? snapshot(activeJob) : null;
    }
  };
}
