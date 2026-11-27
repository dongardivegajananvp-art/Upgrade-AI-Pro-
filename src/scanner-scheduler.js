// Poll scanner work frequently; the FYERS REST scheduler remains the authority
// for the minimum upstream request gap and bounded 429 backoff.
export const SCANNER_POLL_INTERVAL_MS = 1000;
// Background F&O history scans are limited to two per rolling minute so
// account, chart and Entry verification retain capacity after Cloudflare 1015.
export const FNO_SCAN_MIN_INTERVAL_MS = 30_000;
