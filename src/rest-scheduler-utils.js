export function isRestCooldownActive(now, cooldownUntil) {
  return Number(now) < Number(cooldownUntil);
}

export function getRestWaitMs(now, nextRequestAt, cooldownUntil) {
  return Math.max(0, Number(nextRequestAt) - Number(now), Number(cooldownUntil) - Number(now));
}
