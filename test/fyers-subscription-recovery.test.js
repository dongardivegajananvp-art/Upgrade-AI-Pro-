import test from 'node:test';
import assert from 'node:assert/strict';
import { getSocketSubscriptionDelta } from '../src/socket-subscription-utils.js';

test('FYERS auto-reconnect with unchanged symbols sends no duplicate subscriptions', () => {
  const current = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX', 'NSE:ABC-EQ'];
  assert.deepEqual(getSocketSubscriptionDelta(current, current), { removed: [], added: [] });
});

test('FYERS reconnect reconciles only symbols changed while disconnected', () => {
  const current = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX', 'NSE:ABC-EQ', 'NSE:OLD26NOVCE'];
  const desired = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX', 'NSE:XYZ-EQ', 'NSE:NEW26NOVPE'];
  assert.deepEqual(getSocketSubscriptionDelta(current, desired), {
    removed: ['NSE:ABC-EQ', 'NSE:OLD26NOVCE'],
    added: ['NSE:XYZ-EQ', 'NSE:NEW26NOVPE']
  });
});

test('FYERS subscription reconciliation deduplicates symbols and preserves the 24-symbol design', () => {
  const current = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX', 'NSE:ABC-EQ', 'NSE:ABC-EQ'];
  const desired = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX', ...Array.from({length:20},(_,i)=>'NSE:STOCK'+i+'-EQ'), 'NSE:OPT26NOVCE'];
  const delta = getSocketSubscriptionDelta(current, desired);
  assert.equal(new Set([...desired]).size, 24);
  assert.equal(delta.added.length, 21);
  assert.deepEqual(delta.removed, ['NSE:ABC-EQ']);
});
