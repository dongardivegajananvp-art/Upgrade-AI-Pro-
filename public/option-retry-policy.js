export function getOptionRetryDelayMs(status) {
  const code=Number(status);
  if(code===429) return 30_000;
  if(code===0 || (Number.isFinite(code) && code>=500)) return 10_000;
  return null;
}
