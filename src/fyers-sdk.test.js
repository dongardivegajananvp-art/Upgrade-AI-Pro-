import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('pinned FYERS SDK exposes the WebSocket client used by production', () => {
  const sdk = require('fyers-api-v3');
  assert.equal(typeof sdk.fyersDataSocket, 'function');
});
