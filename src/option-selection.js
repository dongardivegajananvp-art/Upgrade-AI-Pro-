// Deterministic option-chain selection. The selected contract is still verified
// against the official FYERS symbol master by the server before subscription.
export function chooseDirectionalOption({ optionsChain = [], underlyingPrice, side } = {}) {
  if (!['LONG', 'SHORT'].includes(side)) {
    return { status: 'UNAVAILABLE', reason: 'A confirmed LONG or SHORT underlying direction is required' };
  }
  const price = Number(underlyingPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { status: 'UNAVAILABLE', reason: 'A fresh positive underlying price is required for strike selection' };
  }
  const optionSide = side === 'LONG' ? 'CE' : 'PE';
  const candidates = (Array.isArray(optionsChain) ? optionsChain : [])
    .filter(row => row && row.option_type === optionSide &&
      typeof row.symbol === 'string' && /^NSE:[A-Z0-9&._-]+$/.test(row.symbol) &&
      Number.isFinite(Number(row.strike_price)) && Number(row.strike_price) > 0)
    .sort((a, b) => Math.abs(Number(a.strike_price) - price) - Math.abs(Number(b.strike_price) - price) ||
      Number(a.strike_price) - Number(b.strike_price));
  if (!candidates.length) {
    return { status: 'UNAVAILABLE', reason: 'No matching directional option contracts were returned by the selected FYERS expiry' };
  }
  const chosen = candidates[0];
  return {
    status: 'CANDIDATE_SELECTED', symbol: chosen.symbol, side: optionSide,
    strike: Number(chosen.strike_price), underlyingSide: side,
    selection: 'NEAREST_ATM_IN_SELECTED_EXPIRY', actionable: false
  };
}

export function normalizeExpiryTimestamp(value) {
  const raw=Number(value);
  if(!Number.isFinite(raw)||raw<=0)return null;
  const seconds=raw>1e12?raw/1000:raw;
  return Number.isFinite(new Date(seconds*1000).getTime())?seconds:null;
}

export function matchesRequestedExpiry(contractExpiry, requestedExpiry) {
  const contract=normalizeExpiryTimestamp(contractExpiry);
  const requested=normalizeExpiryTimestamp(requestedExpiry);
  if(contract===null||requested===null)return false;
  const istDay=value=>new Date((value+19800)*1000).toISOString().slice(0,10);
  return istDay(contract)===istDay(requested);
}
