import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('active setup close telemetry uses the locally computed closed candle time', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(source.includes('setupCandleTime:closedCandleTime'));
  assert.ok(!source.includes('setupCandleTime:lastCompletedCandleTime'));
});
