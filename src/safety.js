export const NSE_SESSION = Object.freeze({ open: '09:15', close: '15:30', timezone: 'Asia/Kolkata' });
export const MIN_REWARD_RISK = 2;
export const FRESH_TICK_MAX_AGE_MS = 10_000;
export function assessFeed(tick, now = Date.now()) {
  if (!tick || !Number.isFinite(Number(tick.exchangeTime)) || !Number.isFinite(Number(tick.receivedAt)) || !Number.isFinite(Number(tick.price)) || Number(tick.price) <= 0) return { status:'MISSING', fresh:false, actionable:false, reason:'Verified FYERS exchange tick is missing' };
  const receivedAge=now-Number(tick.receivedAt), exchangeAge=now/1000-Number(tick.exchangeTime);
  if(receivedAge<0||receivedAge>FRESH_TICK_MAX_AGE_MS||exchangeAge< -3||exchangeAge>10)return{status:'STALE',fresh:false,actionable:false,reason:'Tick timestamp is outside the freshness window'};
  return{status:'FRESH',fresh:true,actionable:true,price:Number(tick.price),exchangeTime:Number(tick.exchangeTime),receivedAt:Number(tick.receivedAt)};
}
export function buildRiskPlan({entry,stopLoss,target,tickSize=0.05}) {
  const values=[entry,stopLoss,target,tickSize].map(Number);
  if(!values.every(Number.isFinite)||values.some(v=>v<=0))return{status:'NO_TRADE',reason:'Invalid price or tick size'};
  const[e,s,t]=values,risk=e-s,reward=t-e;
  if(risk<values[3]-1e-9||reward<=0)return{status:'NO_TRADE',reason:'Invalid long-side Entry/SL/Target structure'};
  const rr=reward/risk;
  if(rr<MIN_REWARD_RISK-1e-9)return{status:'NO_TRADE',reason:'Minimum reward/risk 1:2 not met'};
  return{status:'RISK_PLAN_VALID',entry:e,stopLoss:s,target:t,risk,reward,rr:Number(rr.toFixed(2))};
}
export function tradingEnabled(){return false;}
export function canAdvanceSetup({underlyingTick,optionTick,contractVerified,candlesComplete,strategyConfirmed,riskPlan,now=Date.now()}){
 const underlying=assessFeed(underlyingTick,now),option=assessFeed(optionTick,now);
 if(!underlying.fresh||!option.fresh)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Both underlying and option ticks must be fresh'};
 if(!contractVerified||!candlesComplete||!strategyConfirmed||riskPlan?.status!=='RISK_PLAN_VALID'||riskPlan.rr<MIN_REWARD_RISK)return{status:'NO_TRADE',reason:'Contract, completed candles, strategy, and 1:2 risk plan must all verify'};
 return{status:'SETUP_ELIGIBLE_ORDER_DISABLED',reason:'All data gates passed; broker order placement remains disabled'};
}

/**
 * Whole-lot sizing for a verified long-option plan.
 * riskBudget is an explicit cash allowance, never inferred from account balance.
 * Optional cost assumptions are estimates supplied by the caller, not broker quotes.
 * When absent, sizing remains price-risk-only and explicitly reports that costs
 * and gap risk are not quantified. This function is advisory and never enables orders.
 */
export function calculatePositionSize({
  riskBudget, entry, stopLoss, target, lotSize, contractVerified = false,
  estimatedRoundTripCosts, slippagePerUnit, gapStressPerUnit
} = {}) {
  const values = [riskBudget, entry, stopLoss, target, lotSize].map(Number);
  if (!values.every(Number.isFinite) || values.some(value => value <= 0)) {
    return { status: 'NO_TRADE', reason: 'Explicit positive risk budget, prices, and official lot size are required' };
  }
  if (contractVerified !== true) {
    return { status: 'NO_TRADE', reason: 'Official option contract and lot size must be verified before sizing' };
  }
  if (!Number.isInteger(Number(lotSize))) {
    return { status: 'NO_TRADE', reason: 'Official integer contract lot size is required' };
  }
  const costInputs = [estimatedRoundTripCosts, slippagePerUnit, gapStressPerUnit];
  const anyCostInputProvided = costInputs.some(value => value !== undefined && value !== null && value !== '');
  const costModelConfigured = costInputs.every(value => value !== undefined && value !== null && value !== '');
  if (anyCostInputProvided && !costModelConfigured) {
    return { status: 'NO_TRADE', reason: 'Configure round-trip costs, slippage and gap-stress assumptions together, or omit all three' };
  }
  const costs = costModelConfigured ? costInputs.map(Number) : null;
  if (costModelConfigured && (!costs.every(Number.isFinite) || costs.some(value => value < 0))) {
    return { status: 'NO_TRADE', reason: 'Cost, slippage and gap-stress assumptions must be finite non-negative values' };
  }
  const [budget, buy, stop, objective, lot] = values;
  if (!(stop < buy && objective > buy)) {
    return { status: 'NO_TRADE', reason: 'Long option Entry/SL/Target price structure is invalid' };
  }
  const perUnitRisk = buy - stop;
  const rewardRisk = (objective - buy) / perUnitRisk;
  if (!Number.isFinite(rewardRisk) || rewardRisk < MIN_REWARD_RISK - 1e-9) {
    return { status: 'NO_TRADE', reason: 'Minimum reward/risk 1:2 is not met' };
  }
  const perLotPriceRisk = perUnitRisk * lot;
  if (!Number.isFinite(perLotPriceRisk) || perLotPriceRisk <= 0) {
    return { status: 'NO_TRADE', reason: 'Per-lot risk calculation is invalid' };
  }
  const fixedCosts = costModelConfigured ? costs[0] : 0;
  const perUnitAllowance = costModelConfigured ? costs[1] + costs[2] : 0;
  const perLotModeledRisk = perLotPriceRisk + perUnitAllowance * lot;
  const affordableLots = Math.floor((budget - fixedCosts + 1e-9) / perLotModeledRisk);
  if (affordableLots < 1) {
    return { status: 'NO_TRADE', reason: costModelConfigured
      ? 'Risk budget is below one official lot including configured cost and stress allowances'
      : 'Risk budget is below the price risk of one official lot' };
  }
  const lots = affordableLots;
  const quantity = lots * lot;
  const estimatedPriceRisk = Number((perUnitRisk * quantity).toFixed(8));
  const estimatedSlippage = costModelConfigured ? Number((costs[1] * quantity).toFixed(8)) : null;
  const estimatedGapStress = costModelConfigured ? Number((costs[2] * quantity).toFixed(8)) : null;
  const estimatedRoundTripCostsValue = costModelConfigured ? costs[0] : null;
  const estimatedAllInRisk = costModelConfigured
    ? Number((estimatedPriceRisk + estimatedSlippage + estimatedGapStress + estimatedRoundTripCostsValue).toFixed(8))
    : null;
  if (costModelConfigured && estimatedAllInRisk > budget + 1e-8) {
    return { status: 'NO_TRADE', reason: 'Calculated quantity exceeds the explicit budget after configured cost and stress allowances' };
  }
  if (!costModelConfigured && estimatedPriceRisk > budget + 1e-8) {
    return { status: 'NO_TRADE', reason: 'Calculated quantity exceeds the explicit price-risk budget' };
  }
  return {
    status: 'POSITION_SIZE_VALID', lots, lotSize: lot, quantity,
    riskBudget: budget, estimatedPriceRisk,
    costModelStatus: costModelConfigured ? 'CONFIGURED_ESTIMATE' : 'NOT_CONFIGURED_PRICE_RISK_ONLY',
    estimatedRoundTripCosts: estimatedRoundTripCostsValue,
    estimatedSlippage, estimatedGapStress, estimatedAllInRisk,
    riskBasis: costModelConfigured
      ? 'PRICE_RISK_PLUS_CONFIGURED_ROUND_TRIP_COST_SLIPPAGE_AND_GAP_STRESS_ESTIMATES'
      : 'PRICE_RISK_ONLY_FEES_SLIPPAGE_AND_GAP_RISK_NOT_QUANTIFIED',
    rewardRisk: Number(rewardRisk.toFixed(2)),
    cappedBy: 'EXPLICIT_RISK_BUDGET',
    actionable: false
  };
}
