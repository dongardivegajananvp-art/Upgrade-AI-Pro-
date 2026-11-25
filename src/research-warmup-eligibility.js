import { validateSessionCandleWindow } from './candle-validation.js';

// Multi-timeframe research is only worth warming after the underlying has a
// verified, contiguous 50-candle 5-minute window. This avoids spending the
// constrained FYERS background REST budget on incomplete/stale candidates.
export function isEligibleForResearchWarmup(candles) {
  return validateSessionCandleWindow(candles, 50, 300);
}
