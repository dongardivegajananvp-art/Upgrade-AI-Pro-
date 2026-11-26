export function getOptionRetryDelayMs(status, reason = '') {
  const code=Number(status);
  if(code===429) return 30_000;
  if(code===0 || (Number.isFinite(code) && code>=500)) return 10_000;
  if(code===200 && /fresh selected-underlying.*tick|tick became stale|cooldown|rate.?limit|temporar/i.test(String(reason))) return 10_000;
  return null;
}
