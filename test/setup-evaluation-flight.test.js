import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from '../src/setup-evaluation-flight.js';

test('overlapping evaluations for one contract share one upstream task', async () => {
  const flight = createSingleFlight();
  let calls = 0;
  let release;
  const task = () => { calls += 1; return new Promise(resolve => { release = resolve; }); };
  const first = flight.run('NSE:ABC-EQ|NSE:ABC26NOV100CE', task);
  const second = flight.run('NSE:ABC-EQ|NSE:ABC26NOV100CE', task);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(flight.size, 1);
  release({ status: 'NO_TRADE' });
  assert.deepEqual(await first, { status: 'NO_TRADE' });
  assert.deepEqual(await second, { status: 'NO_TRADE' });
  assert.equal(flight.size, 0);
});

test('different contracts remain independent', async () => {
  const flight = createSingleFlight();
  const a = flight.run('A|CE', async () => 'A');
  const b = flight.run('A|PE', async () => 'B');
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  assert.equal(flight.size, 0);
});

test('failed evaluations clear their key so a safe retry can run', async () => {
  const flight = createSingleFlight();
  await assert.rejects(flight.run('A|CE', async () => { throw new Error('429'); }), /429/);
  assert.equal(flight.has('A|CE'), false);
  assert.equal(await flight.run('A|CE', async () => 'retry'), 'retry');
});
