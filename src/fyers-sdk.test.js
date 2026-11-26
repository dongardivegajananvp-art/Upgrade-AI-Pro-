import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

test('production uses the current FYERS Node SDK and exposes its DataSocket client', () => {
  const sdk = require('fyers-api-v3');
  const packageJson = JSON.parse(readFileSync(require.resolve('fyers-api-v3/package.json'), 'utf8'));
  assert.equal(packageJson.version, '2.5.0');
  assert.equal(typeof sdk.fyersDataSocket, 'function');
});