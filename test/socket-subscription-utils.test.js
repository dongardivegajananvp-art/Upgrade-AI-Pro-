import test from 'node:test';
import assert from 'node:assert/strict';
import { getSocketSubscriptionDelta, splitSubscriptionBatches, buildDesiredSocketSubscriptions, connectWithAutoReconnect, formatSocketCloseDetail, SOCKET_SUBSCRIPTION_BATCH_SIZE, SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS, shouldAdvanceFnoRotation, buildNextSocketSubscriptionOperation, requeueRejectedSocketSubscriptionOperation } from '../src/socket-subscription-utils.js';

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


test('FYERS auto-reconnect is configured before the WebSocket transport connects', () => {
  const events=[];
  const socket={
    autoreconnect(retryCount){events.push(['autoreconnect',retryCount]);},
    connect(){events.push(['connect']);}
  };
  assert.equal(connectWithAutoReconnect(socket,10),true);
  assert.deepEqual(events,[['autoreconnect',10],['connect']]);
});

test('FYERS auto-reconnect retry count is bounded to the SDK supported range', () => {
  const events=[];
  const socket={autoreconnect(value){events.push(value);},connect(){events.push('connect');}};
  connectWithAutoReconnect(socket,1000);
  assert.deepEqual(events,[50,'connect']);
  assert.throws(()=>connectWithAutoReconnect({connect(){}},10),/autoreconnect/);
});


test('socket close diagnostics preserve provider detail while bounding log size', () => {
  assert.equal(formatSocketCloseDetail([]),null);
  assert.equal(formatSocketCloseDetail(['closed', {code:1006,reason:'network'}]),'closed | {"code":1006,"reason":"network"}');
  assert.equal(formatSocketCloseDetail(['x'.repeat(400)]).length,240);
});


test('FYERS subscription pacing uses two larger batches per 20-symbol rotation', () => {
  assert.equal(SOCKET_SUBSCRIPTION_BATCH_SIZE, 10);
  assert.equal(SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS, 30_000);
  const symbols=Array.from({length:11},(_,i)=>String.fromCharCode(65+i));
  assert.deepEqual(splitSubscriptionBatches(symbols, SOCKET_SUBSCRIPTION_BATCH_SIZE), [symbols.slice(0,10),symbols.slice(10)]);
});

test('F&O rotation waits until paced subscriptions drain and rate-limit cooldown ends', () => {
  assert.equal(shouldAdvanceFnoRotation({pendingCount: 1, cooldownActive: false}), false);
  assert.equal(shouldAdvanceFnoRotation({pendingCount: 0, cooldownActive: true}), false);
  assert.equal(shouldAdvanceFnoRotation({pendingCount: 0, cooldownActive: false}), true);
});


test('F&O candle observation snapshots include active slice, pinned Top Gainers, and selected underlying', async () => {
  const { buildFnoCandleObservationSymbols } = await import('../src/socket-subscription-utils.js');
  const symbols = buildFnoCandleObservationSymbols(
    ['NSE:SLICE-A-EQ', 'NSE:SLICE-B-EQ'],
    ['NSE:TOP-A-EQ', 'NSE:TOP-B-EQ', 'NSE:SLICE-A-EQ'],
    'NSE:SELECTED-EQ'
  );
  assert.deepEqual(symbols, ['NSE:SLICE-A-EQ', 'NSE:SLICE-B-EQ', 'NSE:TOP-A-EQ', 'NSE:TOP-B-EQ', 'NSE:SELECTED-EQ']);
});

test('F&O candle observation symbol selection rejects invalid symbols and remains unique', async () => {
  const { buildFnoCandleObservationSymbols } = await import('../src/socket-subscription-utils.js');
  assert.deepEqual(buildFnoCandleObservationSymbols(['MCX:CRUDEOIL26NOVFUT', 'NSE:ABC-EQ', 'NSE:ABC-EQ'], ['bad-symbol']), ['NSE:ABC-EQ']);
});


test('WebSocket control queue serializes unsubscribe before subscribe in bounded batches', () => {
  assert.deepEqual(buildNextSocketSubscriptionOperation(['OLD-A','OLD-B','OLD-C'], ['NEW-A'], 2), {type:'unsubscribe',symbols:['OLD-A','OLD-B']});
  assert.deepEqual(buildNextSocketSubscriptionOperation(['OLD-C'], ['NEW-A'], 2), {type:'unsubscribe',symbols:['OLD-C']});
  assert.deepEqual(buildNextSocketSubscriptionOperation([], ['NEW-A','NEW-B'], 2), {type:'subscribe',symbols:['NEW-A','NEW-B']});
  assert.equal(buildNextSocketSubscriptionOperation([], []), null);
});

test('1015 requeues the exact rejected WebSocket operation without confusing subscribe and unsubscribe', () => {
  assert.deepEqual(requeueRejectedSocketSubscriptionOperation({type:'unsubscribe',symbols:['OLD-A']}, [], ['NEW-A']), {
    pendingUnsubscribeSymbols:['OLD-A'], pendingSubscribeSymbols:['NEW-A']
  });
  assert.deepEqual(requeueRejectedSocketSubscriptionOperation({type:'subscribe',symbols:['NEW-B']}, ['OLD-B'], []), {
    pendingUnsubscribeSymbols:['OLD-B'], pendingSubscribeSymbols:['NEW-B']
  });
});
