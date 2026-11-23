import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldActivateFnoSliceOnFeedRecovery } from '../src/fno-feed-readiness.js';

test('activates the first F&O slice immediately when fresh index feed returns', () => {
  assert.equal(shouldActivateFnoSliceOnFeedRecovery(false, true, 218), true);
});

test('does not reapply the F&O slice for every subsequent fresh index tick', () => {
  assert.equal(shouldActivateFnoSliceOnFeedRecovery(true, true, 218), false);
});

test('does not activate F&O without a loaded official universe or fresh index feed', () => {
  assert.equal(shouldActivateFnoSliceOnFeedRecovery(false, true, 0), false);
  assert.equal(shouldActivateFnoSliceOnFeedRecovery(false, false, 218), false);
});
