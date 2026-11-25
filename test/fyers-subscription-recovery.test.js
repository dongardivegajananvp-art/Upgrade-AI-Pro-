import test from 'node:test';
import assert from 'node:assert/strict';
import { getSocketSubscriptionDelta, buildSocketSubscriptionDiagnostics, pruneSymbolMap, isGenericSubscriptionAck, prioritizeSubscriptionQueue } from '../src/socket-subscription-utils.js';

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


test('WebSocket diagnostics distinguish desired symbols, SDK sends and pending subscriptions', () => {
  const state = buildSocketSubscriptionDiagnostics({
    desired:['NSE:NIFTY50-INDEX','NSE:ABC-EQ','NSE:ABC-EQ'],
    sentToSdk:['NSE:NIFTY50-INDEX'],
    pending:['NSE:ABC-EQ','NSE:ABC-EQ']
  });
  assert.equal(state.desiredCount,2);
  assert.equal(state.sentToSdkCount,1);
  assert.equal(state.pendingCount,1);
  assert.deepEqual(state.pendingSymbols,['NSE:ABC-EQ']);
  assert.equal(state.confirmation,'SDK_SEND_STATE_ONLY');
});


test('socket tick and telemetry maps prune obsolete symbols and stay bounded', () => {
  const map = new Map([['NSE:KEEP-EQ',1],['NSE:OLD-EQ',2],['NSE:A-EQ',3],['NSE:B-EQ',4]]);
  assert.equal(pruneSymbolMap(map,['NSE:KEEP-EQ','NSE:A-EQ','NSE:B-EQ'],2),2);
  assert.deepEqual([...map.keys()],['NSE:A-EQ','NSE:B-EQ']);
});


test('FYERS generic subscription ACK is recognized without assigning symbol identity', () => {
  assert.equal(isGenericSubscriptionAck({ type: 'sub', code: 200 }), true);
  assert.equal(isGenericSubscriptionAck({ type: 'sub', code: 200, symbol: 'NSE:ABC-EQ' }), true);
  assert.equal(isGenericSubscriptionAck({ type: 'sub', code: 429 }), false);
  assert.equal(isGenericSubscriptionAck({ type: 'symbol_sub', code: 200 }), false);
  assert.equal(isGenericSubscriptionAck(null), false);
});


test('selected option subscription moves ahead of queued background F&O symbols', () => {
  const pending = ['NSE:STOCK1-EQ','NSE:STOCK2-EQ','NSE:STOCK3-EQ','NSE:ANGELONE26DEC345CE'];
  assert.deepEqual(prioritizeSubscriptionQueue(pending,'NSE:ANGELONE26DEC345CE'), [
    'NSE:ANGELONE26DEC345CE','NSE:STOCK1-EQ','NSE:STOCK2-EQ','NSE:STOCK3-EQ'
  ]);
});

test('selected option priority preserves deduplication and leaves unrelated queue order intact', () => {
  assert.deepEqual(prioritizeSubscriptionQueue(
    ['NSE:A-EQ','NSE:B-EQ','NSE:A-EQ','NSE:C-EQ'],
    'NSE:OPTION26DECCE'
  ), ['NSE:A-EQ','NSE:B-EQ','NSE:C-EQ']);
});
