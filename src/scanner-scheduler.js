// Poll scanner work frequently; the FYERS REST scheduler remains the authority
// for the minimum upstream request gap and one-hour 429 cooldown.
export const SCANNER_POLL_INTERVAL_MS = 1000;
