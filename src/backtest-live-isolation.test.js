import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('live server does not import or instantiate the historical backtest runner', () => {
  assert.doesNotMatch(serverSource, /backtest-batch|createHistoricalFnoBacktestRunner|historicalFnoBacktest/);
  assert.doesNotMatch(serverSource, /getHistoricalBacktestHistory/);
});

test('legacy live-process backtest API is explicitly disabled for GET and POST', () => {
  assert.equal((serverSource.match(/BACKTEST_ISOLATED/g) || []).length, 2);
  assert.match(serverSource, /req\.method === 'GET'[\s\S]{0,500}BACKTEST_ISOLATED/);
  assert.match(serverSource, /req\.method === 'POST'[\s\S]{0,500}BACKTEST_ISOLATED/);
  assert.match(serverSource, /Historical backtests must run in a separate worker/);
});
