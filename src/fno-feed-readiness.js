export function shouldActivateFnoSliceOnFeedRecovery(previousReady, nextReady, universeCount) {
  return previousReady === false && nextReady === true && Number(universeCount) > 0;
}
