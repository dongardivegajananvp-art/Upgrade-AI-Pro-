// NSE regular cash-market session gate. Times are interpreted in Asia/Kolkata (UTC+05:30).
// This is a weekday/time guard only; a fresh exchange index tick is additionally
// required by the live scanner to avoid scanning on exchange holidays.
export function isNseRegularSession(now = Date.now()) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const ist = new Date(timestamp + 19800000);
  const day = ist.getUTCDay();
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && minute >= 555 && minute < 930;
}


// Signal generation stays enabled for the complete regular NSE session.
// New opportunities may be evaluated whenever verified market data confirms them.
export function isNseSignalWindow(now = Date.now()) {
  return isNseRegularSession(now);
}
