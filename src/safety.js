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
 * Conservative lot-based sizing for a verified long option premium plan.
 * riskBudget is an explicit cash amount supplied by the operator; it is never
 * inferred from account balance. lotSize must come from the verified contract
 * master. This is advisory only and cannot enable broker order placement.
 */
export function calculatePositionSize({
  riskBudget, entry, stopLoss, target, lotSize, contractVerified = false,
  maxLots = 2
} = {}) {
  const values = [riskBudget, entry, stopLoss, target, lotSize].map(Number);
  if (!values.every(Number.isFinite) || values.some(value => value <= 0)) {
    return { status: 'NO_TRADE', reason: 'Explicit positive risk budget, prices, and official lot size are required' };
  }
  if (contractVerified !== true) {
    return { status: 'NO_TRADE', reason: 'Official option contract and lot size must be verified before sizing' };
  }
  if (!Number.isInteger(Number(lotSize)) || !Number.isInteger(Number(maxLots)) ||
      Number(maxLots) < 1 || Number(maxLots) > 2) {
    return { status: 'NO_TRADE', reason: 'Official integer lot size and maxLots between one and two are required' };
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
  const perLotRisk = perUnitRisk * lot;
  if (!Number.isFinite(perLotRisk) || perLotRisk <= 0) {
    return { status: 'NO_TRADE', reason: 'Per-lot risk calculation is invalid' };
  }
  const affordableLots = Math.floor((budget + 1e-9) / perLotRisk);
  const lots = Math.min(affordableLots, Number(maxLots));
  if (lots < 1) {
    return { status: 'NO_TRADE', reason: 'Risk budget is below the risk of one official lot' };
  }
  const quantity = lots * lot;
  const estimatedPriceRisk = Number((perUnitRisk * quantity).toFixed(8));
  if (estimatedPriceRisk > budget + 1e-8) {
    return { status: 'NO_TRADE', reason: 'Calculated quantity exceeds the explicit risk budget' };
  }
  return {
    status: 'POSITION_SIZE_VALID', lots, lotSize: lot, quantity,
    riskBudget: budget, estimatedPriceRisk,
    riskBasis: 'ENTRY_TO_STOP_PRICE_DIFFERENCE_EXCLUDES_FEES_SLIPPAGE_AND_GAP_RISK',
    rewardRisk: Number(rewardRisk.toFixed(2)),
    cappedBy: affordableLots > Number(maxLots) ? 'MAX_LOTS' : 'RISK_BUDGET',
    actionable: false
  };
}
