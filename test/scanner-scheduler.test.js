import test from 'node:test';
import assert from 'node:assert/strict';
import { SCANNER_POLL_INTERVAL_MS } from '../src/scanner-scheduler.js';
import { getRestDiagnostics } from '../src/fyers-rest.js';

test('scanner polling retries busy ticks without weakening FYERS REST pacing', () => {
  const rest = getRestDiagnostics();
  assert.equal(SCANNER_POLL_INTERVAL_MS, 1000);
  assert.equal(rest.minGapMs, 4000);
  assert.ok(SCANNER_POLL_INTERVAL_MS < rest.minGapMs);
});
