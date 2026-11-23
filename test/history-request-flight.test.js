import test from 'node:test';
import assert from 'node:assert/strict';
import { runHistoryRequestOnce } from '../src/history-request-flight.js';

test('concurrent requests for the same history key share one upstream read', async () => {
  let calls = 0;
  let release;
  const task = () => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  };
  const first = runHistoryRequestOnce('5m:NSE:ABC-EQ', task);
  const second = runHistoryRequestOnce('5m:NSE:ABC-EQ', task);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ candles: [1, 2, 3] });
  assert.deepEqual(await first, { candles: [1, 2, 3] });
  assert.deepEqual(await second, { candles: [1, 2, 3] });
});

test('different symbols and timeframes remain independent', async () => {
  const [a, b, c] = await Promise.all([
    runHistoryRequestOnce('5m:NSE:ABC-EQ', async () => '5m'),
    runHistoryRequestOnce('15m:NSE:ABC-EQ', async () => '15m'),
    runHistoryRequestOnce('5m:NSE:XYZ-EQ', async () => 'XYZ')
  ]);
  assert.deepEqual([a, b, c], ['5m', '15m', 'XYZ']);
});

test('a failed history read clears its key for a later safe retry', async () => {
  await assert.rejects(runHistoryRequestOnce('1d:NSE:ABC-EQ', async () => {
    throw new Error('FYERS 429');
  }), /FYERS 429/);
  assert.equal(await runHistoryRequestOnce('1d:NSE:ABC-EQ', async () => 'retry'), 'retry');
});
