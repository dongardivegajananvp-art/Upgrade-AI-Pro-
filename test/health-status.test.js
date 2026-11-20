import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthStatus } from '../src/health-status.js';

test('health endpoint reports actual connected feed and fresh index count', () => {
  const status = buildHealthStatus({
    market: {
      socketStatus: 'CONNECTED',
      indices: { a: { fresh: true }, b: { fresh: true }, c: { fresh: false } },
      fno: { status: 'ROTATING_LIVE_COVERAGE' }
    },
    masterCurrent: true,
    sessionDate: '2026-11-20',
    loadedDate: '2026-11-20',
    ordersEnabled: false
  });
  assert.equal(status.ok, true);
  assert.equal(status.marketData, 'CONNECTED');
  assert.deepEqual(status.indexFeed, { freshCount: 2, totalCount: 3 });
  assert.equal(status.fnoMaster.status, 'CURRENT');
  assert.equal(status.fno.status, 'ROTATING_LIVE_COVERAGE');
  assert.equal(status.orders, 'DISABLED');
});

test('health endpoint does not misreport disconnected or missing feed as connected', () => {
  const status = buildHealthStatus({ market: { socketStatus: 'DISCONNECTED', indices: {} } });
  assert.equal(status.ok, true);
  assert.equal(status.marketData, 'DISCONNECTED');
  assert.deepEqual(status.indexFeed, { freshCount: 0, totalCount: 0 });
  assert.equal(status.fnoMaster.status, 'REFRESH_PENDING');
  assert.equal(status.orders, 'DISABLED');
});

test('health endpoint reports not-started state when no market socket exists', () => {
  const status = buildHealthStatus();
  assert.equal(status.marketData, 'NOT_STARTED');
  assert.equal(status.fno.status, 'UNKNOWN');
});

test('health endpoint exposes scanner progress, F&O coverage, REST cooldown and memory without enabling orders', () => {
  const status = buildHealthStatus({
    market: {
      socketStatus: 'CONNECTED',
      indices: { a: { fresh: true }, b: null },
      fno: { status: 'ROTATING_LIVE_COVERAGE', universeCount: 218, activeCount: 20, observedCount: 74, coverageComplete: false, topGainers: [{fresh:true},{fresh:false}] },
      optionSubscription: { status: 'SUBSCRIPTION_SENT', tickAgeSeconds: 8 },
      selectedOption: { fresh: false }
    },
    masterCurrent: true,
    scanner: { status: 'RUNNING', scannedCount: 22, sliceScannedCount: 11, lastSymbol: 'NSE:ABC-EQ', lastStatus: 'NO_TRADE', warmupStatus: 'VERIFIED_DAILY_15M_CACHED', warmupQueueDepth: 2, warmupCompletedCount: 4, warmupRetryCount: 1, warmupRejectedCount: 0 },
    scanPerSlice: 11,
    rotationIntervalMs: 60000,
    rest: { minGapMs: 4000, cooldownActive: true, cooldownUntil: '2026-11-20T11:00:00.000Z' },
    runtimeMemory: { rss: 400000000, heapUsed: 100000000, heapTotal: 200000000, external: 10000000 },
    ordersEnabled: false
  });
  assert.equal(status.scanner.status, 'RUNNING');
  assert.equal(status.scanner.scannedCount, 22);
  assert.equal(status.scanner.scanPerSlice, 11);
  assert.equal(status.fno.universeCount, 218);
  assert.equal(status.fno.topGainersFreshCount, 1);
  assert.equal(status.option.tickFresh, false);
  assert.equal(status.rest.cooldownActive, true);
  assert.equal(status.runtimeMemory.rssBytes, 400000000);
  assert.equal(status.orders, 'DISABLED');
});
