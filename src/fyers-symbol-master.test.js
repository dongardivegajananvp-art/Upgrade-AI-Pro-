import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFnoEquityUniverse } from './fyers-symbol-master.js';

test('maps active F&O underlyings using official NSE cash ticker', () => {
  const now = Date.UTC(2026, 10, 19, 4, 0);
  const expiry = String(Math.floor((now + 7 * 86400000) / 1000));
  const fo = {
    'NSE:SBIN26NOV1000CE': { symTicker:'NSE:SBIN26NOV1000CE', optType:'CE', expiryDate:expiry, underSym:'SBIN', tradeStatus:1 },
    'NSE:SBIN26NOV1000PE': { symTicker:'NSE:SBIN26NOV1000PE', optType:'PE', expiryDate:expiry, underSym:'SBIN', tradeStatus:1 },
    'NSE:OLD26NOV1000CE': { symTicker:'NSE:OLD26NOV1000CE', optType:'CE', expiryDate:'1000000000', underSym:'OLD', tradeStatus:1 },
    'NSE:HALF26NOV1000CE': { symTicker:'NSE:HALF26NOV1000CE', optType:'CE', expiryDate:expiry, underSym:'HALF', tradeStatus:0 }
  };
  const cm = {
    'NSE:SBIN-EQ': { symTicker:'NSE:SBIN-EQ', fyToken:'101', symDetails:'STATE BANK OF INDIA', tradeStatus:1 },
    'NSE:OLD-EQ': { symTicker:'NSE:OLD-EQ', fyToken:'102', tradeStatus:1 }
  };
  const result = buildFnoEquityUniverse(fo, cm, now);
  assert.deepEqual(result.universe.map(row=>row.symbol), ['NSE:SBIN-EQ']);
  assert.equal(result.diagnostics.activeOptionContracts, 2);
});
test('keeps contracts expiring today valid through the IST expiry day', () => {
  const now = Date.UTC(2026, 10, 19, 5, 0);
  const expiryMidnight = String(Math.floor(Date.UTC(2026, 10, 18, 18, 30) / 1000));
  const fo = { 'NSE:SBIN26NOV1000CE': { symTicker:'NSE:SBIN26NOV1000CE', optType:'CE', expiryDate:expiryMidnight, underSym:'SBIN' } };
  const cm = { 'NSE:SBIN-EQ': { symTicker:'NSE:SBIN-EQ', fyToken:'101' } };
  const result = buildFnoEquityUniverse(fo, cm, now);
  assert.equal(result.universe.length, 1);
});
