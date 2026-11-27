import test from 'node:test';
import assert from 'node:assert/strict';
import { SCANNER_POLL_INTERVAL_MS, FNO_SCAN_MIN_INTERVAL_MS } from '../src/scanner-scheduler.js';
import { FNO_SCAN_PER_SLICE } from '../src/rolling-fno-scanner.js';
import { getRestDiagnostics } from '../src/fyers-rest.js';

test('scanner polling retries busy ticks without weakening FYERS REST pacing', () => {
  const rest = getRestDiagnostics();
  assert.equal(SCANNER_POLL_INTERVAL_MS, 1000);
  assert.equal(FNO_SCAN_MIN_INTERVAL_MS, 30_000);
  assert.equal(FNO_SCAN_PER_SLICE, rest.backgroundRollingWindowLimitPerMinute);
  assert.equal(FNO_SCAN_MIN_INTERVAL_MS * FNO_SCAN_PER_SLICE, 60_000);
  assert.ok(FNO_SCAN_MIN_INTERVAL_MS >= 60_000 / rest.backgroundRollingWindowLimitPerMinute);
  assert.equal(rest.minGapMs, 4000);
  assert.ok(SCANNER_POLL_INTERVAL_MS < rest.minGapMs);
});
