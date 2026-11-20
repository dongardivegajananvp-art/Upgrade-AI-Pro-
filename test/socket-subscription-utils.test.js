import test from 'node:test';
import assert from 'node:assert/strict';
import { getSocketSubscriptionDelta, splitSubscriptionBatches } from '../src/socket-subscription-utils.js';

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
