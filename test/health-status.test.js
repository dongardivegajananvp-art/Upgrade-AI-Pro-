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
  assert.equal(status.fno, 'ROTATING_LIVE_COVERAGE');
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
  assert.equal(status.fno, 'UNKNOWN');
});
