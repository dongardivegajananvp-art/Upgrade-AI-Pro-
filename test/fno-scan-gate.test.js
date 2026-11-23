import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreshFnoTick } from '../src/fno-scan-gate.js';

test('scanner history gate requires both fresh receive and exchange timestamps', () => {
  const now = 1_800_000_000_000;
  assert.equal(isFreshFnoTick({ receivedAt: now - 500, exchangeTime: now / 1000 - 1 }, now), true);
  assert.equal(isFreshFnoTick({ receivedAt: now - 10_001, exchangeTime: now / 1000 - 1 }, now), false);
  assert.equal(isFreshFnoTick({ receivedAt: now - 500, exchangeTime: now / 1000 - 11 }, now), false);
  assert.equal(isFreshFnoTick({ receivedAt: now - 500, exchangeTime: now / 1000 + 4 }, now), false);
  assert.equal(isFreshFnoTick(null, now), false);
});
