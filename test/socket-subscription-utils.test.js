import test from 'node:test';
import assert from 'node:assert/strict';
import { getSocketSubscriptionDelta, splitSubscriptionBatches, buildDesiredSocketSubscriptions } from '../src/socket-subscription-utils.js';

test('subscription delta avoids duplicate additions and removes obsolete symbols', () => {
  assert.deepEqual(getSocketSubscriptionDelta(['A', 'B', 'A'], ['B', 'C', 'C']), {
    removed: ['A'], added: ['C']
  });
});

test('subscription batches are bounded, ordered, and de-duplicated', () => {
  assert.deepEqual(splitSubscriptionBatches(['A','B','C','D','E','F','A'], 4), [
    ['A','B','C','D'], ['E','F']
  ]);
});

test('invalid batch sizes fall back to a safe positive size', () => {
  assert.deepEqual(splitSubscriptionBatches(['A','B'], 0), [['A','B']]);
});

test('desired subscriptions are rebuilt from the current underlying slice and selected option', () => {
  const initial=buildDesiredSocketSubscriptions(['IDX'],['OLD-A','OLD-B'],'NSE:OLDCE');
  const afterSelectionChange=buildDesiredSocketSubscriptions(['IDX'],['NEW-A','NEW-B'],'NSE:NEWCE');
  assert.deepEqual(initial,['IDX','OLD-A','OLD-B','NSE:OLDCE']);
  assert.deepEqual(afterSelectionChange,['IDX','NEW-A','NEW-B','NSE:NEWCE']);
  assert.equal(afterSelectionChange.includes('OLD-A'),false);
  assert.equal(afterSelectionChange.includes('NSE:OLDCE'),false);
});


test('reconnect reconciliation resubscribes the complete desired set after transport close', async () => {
  const { getSocketSubscriptionDelta, buildDesiredSocketSubscriptions } = await import('../src/socket-subscription-utils.js');
  const desired = buildDesiredSocketSubscriptions(
    ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'],
    ['NSE:RELIANCE-EQ', 'NSE:TCS-EQ'],
    'NSE:RELIANCE26NOV2500CE'
  );
  // A transport close clears the locally acknowledged set. On reconnect every
  // desired subscription must therefore be queued again, without duplicates.
  const delta = getSocketSubscriptionDelta([], desired);
  assert.deepEqual(delta.removed, []);
  assert.deepEqual(delta.added, desired);
  assert.equal(new Set(delta.added).size, desired.length);
});

test('reconnect desired subscription reconciliation remains within the Standard symbol cap', async () => {
  const { buildDesiredSocketSubscriptions } = await import('../src/socket-subscription-utils.js');
  const active = Array.from({length:20},(_,i)=>'NSE:STOCK'+i+'-EQ');
  const desired = buildDesiredSocketSubscriptions(
    ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'],
    active,
    'NSE:RELIANCE26NOV2500CE'
  );
  assert.equal(desired.length,24);
  assert.ok(desired.length<=100);
});


test('off-session socket plan retains indices but excludes F&O and selected option', async () => {
  const { buildSessionSocketSubscriptions } = await import('../src/socket-subscription-utils.js');
  assert.deepEqual(buildSessionSocketSubscriptions(['IDX-A','IDX-B'],['NSE:ABC-EQ'],'NSE:ABC26NOV100CE',false),['IDX-A','IDX-B']);
});

test('session-ready socket plan includes active F&O and selected option', async () => {
  const { buildSessionSocketSubscriptions } = await import('../src/socket-subscription-utils.js');
  assert.deepEqual(buildSessionSocketSubscriptions(['IDX-A'],['NSE:ABC-EQ'],'NSE:ABC26NOV100CE',true),['IDX-A','NSE:ABC-EQ','NSE:ABC26NOV100CE']);
});


test('one-symbol subscription pacing can serialize newly added symbols safely', () => {
  assert.deepEqual(splitSubscriptionBatches(['A','B','C'], 1), [['A'], ['B'], ['C']]);
});
