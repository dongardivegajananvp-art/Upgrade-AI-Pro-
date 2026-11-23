// Poll scanner work frequently; the FYERS REST scheduler remains the authority
// for the minimum upstream request gap and bounded 429 backoff.
export const SCANNER_POLL_INTERVAL_MS = 1000;
