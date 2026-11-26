// Poll scanner work frequently; the FYERS REST scheduler remains the authority
// for the minimum upstream request gap and bounded 429 backoff.
export const SCANNER_POLL_INTERVAL_MS = 1000;
// Background F&O history scans are capped at three per rolling minute by the
// shared REST governor. Use the full safe allowance instead of one scan/minute.
export const FNO_SCAN_MIN_INTERVAL_MS = 20_000;
