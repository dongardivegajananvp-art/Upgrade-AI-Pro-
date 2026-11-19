import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFnoEquityUniverse } from './fyers-symbol-master.js';

test('F&O universe maps active option underlyings only through official NSE cash symbols', () => {
  const now = Date.UTC(2026, 10, 19, 4, 0) ;
  const futureExpiry = String(Math.floor((now + 7 * 86400000) / 1000));
  const fo = {
    a: { optType: 'CE', expiryDate: futureExpiry, underSym: 'SBIN' },
    b: { optType: 'PE', expiryDate: futureExpiry, underSym: 'SBIN' },
    c: { optType: 'CE', expiryDate: '1000000000', underSym: 'OLDSTOCK' },
    d: { optType: 'XX', expiryDate: futureExpiry, underSym: 'NOTOPTION' }
  };
  const cm = {
    a: { exSymName: 'SBIN', symTicker: 'NSE:SBIN-EQ', fyToken: '101', symDetails: 'STATE BANK OF INDIA' },
    b: { exSymName: 'OLDSTOCK', symTicker: 'NSE:OLDSTOCK-EQ', fyToken: '102' },
    c: { exSymName: 'BSEONLY', symTicker: 'BSE:BSEONLY-EQ', fyToken: '103' }
  };
  const result = buildFnoEquityUniverse(fo, cm, now);
  assert.equal(result.universe.length, 1);
  assert.equal(result.universe[0].symbol, 'NSE:SBIN-EQ');
  assert.equal(result.universe[0].fyToken, '101');
});
