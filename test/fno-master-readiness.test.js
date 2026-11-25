import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCurrentFnoMaster } from '../src/fno-master-readiness.js';

test('waits for the in-flight official master refresh before checking readiness', async () => {
  let loaded = false;
  let release;
  const loadPromise = new Promise(resolve => { release = resolve; });
  const readiness = waitForCurrentFnoMaster({ loadPromise, isCurrent: () => loaded });
  await Promise.resolve();
  assert.equal(loaded, false);
  loaded = true;
  release(true);
  assert.equal(await readiness, true);
});

test('fails closed when the current-session master refresh fails', async () => {
  assert.equal(await waitForCurrentFnoMaster({ loadPromise: Promise.reject(new Error('download failed')), isCurrent: () => false }), false);
});

test('does not wait when there is no current-session refresh in flight', async () => {
  assert.equal(await waitForCurrentFnoMaster({ loadPromise: null, isCurrent: () => true }), true);
});
