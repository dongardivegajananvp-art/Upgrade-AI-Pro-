import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoricalFnoBacktestRunner } from './backtest-batch.js';

const fixedNow = Date.parse('2026-11-24T05:00:00Z');
async function waitForTerminal(runner, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = runner.get(jobId);
    if (job && !['QUEUED', 'RUNNING'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Historical backtest test job did not reach a terminal state');
}

test('three-month F&O batch accepts only unique official NSE equity symbols and exposes read-only state', async () => {
  const calls = [];
  const runner = createHistoricalFnoBacktestRunner({
    now: () => fixedNow,
    fetchHistory: async input => {
      calls.push(input);
      return { dataProvenance: 'FYERS_HISTORICAL_API', fiveMinuteCandles: [], dailyCandles: [] };
    },
    replay: ({ symbol }) => ({
      status: 'COMPLETE', actionable: false, signalCount: 1,
      summary: { EMA20_EMA50_TREND: 1 }, signals: [{ symbol, pnl: null }]
    })
  });
  const started = runner.start({ months: 3, universe: [
    { symbol: 'NSE:SBIN-EQ' }, { symbol: 'NSE:SBIN-EQ' },
    { symbol: 'BSE:RELIANCE-EQ' }, { symbol: 'NSE:NIFTY50-INDEX' },
    { symbol: 'NSE:RELIANCE-EQ' }
  ] });
  assert.equal(started.accepted, true);
  assert.equal(started.job.universeCount, 2);
  assert.equal(started.job.mode, 'FNO_STOCKS_3_MONTH_HISTORICAL_SIGNAL_REPLAY');
  assert.equal(started.job.actionable, false);
  assert.equal(started.job.ordersEnabled, false);
  assert.equal(runner.start({ months: 3, universe: [{ symbol: 'NSE:SBIN-EQ' }] }).accepted, false);
  const final = await waitForTerminal(runner, started.job.id);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.processedCount, 2);
  assert.equal(final.signalCount, 2);
  assert.equal(final.strategySummary.EMA20_EMA50_TREND, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.startTime < call.endTime));
  assert.ok(final.limitations.some(value => /option-trade P&L backtest/.test(value)));
});

test('batch blocks a symbol when the history adapter does not attest FYERS provenance', async () => {
  const runner = createHistoricalFnoBacktestRunner({
    now: () => fixedNow,
    fetchHistory: async () => ({ dataProvenance: 'SYNTHETIC', fiveMinuteCandles: [], dailyCandles: [] })
  });
  const started = runner.start({ universe: [{ symbol: 'NSE:SBIN-EQ' }] });
  const final = await waitForTerminal(runner, started.job.id);
  assert.equal(final.status, 'DATA_UNAVAILABLE');
  assert.equal(final.completedCount, 0);
  assert.equal(final.blockedCount, 1);
  assert.match(final.failures[0].reason, /did not attest FYERS_HISTORICAL_API/);
});

test('batch fails closed for unsupported month count and malformed universe', () => {
  const runner = createHistoricalFnoBacktestRunner({ fetchHistory: async () => ({}) });
  assert.equal(runner.start({ months: 6, universe: [{ symbol: 'NSE:SBIN-EQ' }] }).accepted, false);
  assert.equal(runner.start({ months: 3, universe: [{ symbol: 'NSE:NIFTY50-INDEX' }] }).accepted, false);
  assert.equal(runner.start({ months: 3, universe: [] }).accepted, false);
});

test('batch reports missing data without inventing signals or P&L', async () => {
  const runner = createHistoricalFnoBacktestRunner({
    now: () => fixedNow,
    fetchHistory: async () => ({ dataProvenance: 'FYERS_HISTORICAL_API', fiveMinuteCandles: [], dailyCandles: [] }),
    replay: () => ({ status: 'DATA_UNAVAILABLE', actionable: false, reason: 'Missing candles', signals: [], summary: {} })
  });
  const started = runner.start({ universe: [{ symbol: 'NSE:SBIN-EQ' }] });
  const final = await waitForTerminal(runner, started.job.id);
  assert.equal(final.status, 'DATA_UNAVAILABLE');
  assert.equal(final.signalCount, 0);
  assert.deepEqual(final.signals, []);
  assert.equal(final.ordersEnabled, false);
});

test('batch pauses without skipping symbols on a FYERS cooldown and resumes at the same symbol', async () => {
  let firstAttempt = true;
  const fetched = [];
  const runner = createHistoricalFnoBacktestRunner({
    now: () => fixedNow,
    fetchHistory: async ({ symbol }) => {
      fetched.push(symbol);
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('FYERS REST cooldown active; no upstream request was sent');
      }
      return { dataProvenance: 'FYERS_HISTORICAL_API', fiveMinuteCandles: [], dailyCandles: [] };
    },
    replay: () => ({ status: 'COMPLETE', actionable: false, signalCount: 0, summary: {}, signals: [] })
  });
  const started = runner.start({ universe: [{ symbol: 'NSE:SBIN-EQ' }, { symbol: 'NSE:RELIANCE-EQ' }] });
  const paused = await waitForTerminal(runner, started.job.id);
  assert.equal(paused.status, 'PAUSED_UPSTREAM_GUARD');
  assert.equal(paused.processedCount, 0);
  assert.equal(paused.nextIndex, 0);
  assert.equal(runner.resume(started.job.id), true);
  const final = await waitForTerminal(runner, started.job.id);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.processedCount, 2);
  assert.deepEqual(fetched, ['NSE:RELIANCE-EQ', 'NSE:RELIANCE-EQ', 'NSE:SBIN-EQ']);
});
