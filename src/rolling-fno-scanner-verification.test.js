import test from 'node:test';
import assert from 'node:assert/strict';
import { FNO_SCAN_PER_SLICE, FNO_SOCKET_ROTATION_ADVANCE, buildFnoRotationSlice } from './rolling-fno-scanner.js';

test('F&O live socket rotation is twenty symbols per minute while REST strategy checks stay budgeted', () => {
  const universe = Array.from({ length: 200 }, (_, index) => ({ symbol: 'NSE:STOCK' + index + '-EQ' }));
  assert.equal(FNO_SOCKET_ROTATION_ADVANCE, 20);
  assert.equal(FNO_SCAN_PER_SLICE, 3);
  assert.equal(buildFnoRotationSlice(universe, 0, FNO_SOCKET_ROTATION_ADVANCE).length, 20);
  assert.equal(buildFnoRotationSlice(universe, 20, FNO_SOCKET_ROTATION_ADVANCE)[0].symbol, 'NSE:STOCK20-EQ');
  assert.equal(Math.ceil(universe.length / FNO_SOCKET_ROTATION_ADVANCE), 10);
});

test('F&O scan symbol selection rejects exchange-to-receipt delay above five seconds', async () => {
  const { getNextFreshFnoScanSymbol } = await import('./rolling-fno-scanner.js');
  const now = 1_800_000_000_000;
  const ticks = new Map([
    ['NSE:DELAYED-EQ', { price: 100, receivedAt: now - 1000, exchangeTime: (now - 7000) / 1000 }],
    ['NSE:FRESH-EQ', { price: 100, receivedAt: now - 1000, exchangeTime: (now - 2000) / 1000 }]
  ]);
  assert.equal(getNextFreshFnoScanSymbol(['NSE:DELAYED-EQ', 'NSE:FRESH-EQ'], ticks, new Map(), now), 'NSE:FRESH-EQ');
});
