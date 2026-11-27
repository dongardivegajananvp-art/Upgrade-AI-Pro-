export function validateFixedRiskPlan({ entry, stopLoss, target, minRR = 2 } = {}) {
  const e=Number(entry), sl=Number(stopLoss), t=Number(target);
  const risk=e-sl, reward=t-e;
  const rr=reward/risk;
  const ok=[e,sl,t,minRR].every(Number.isFinite) && e>0 && sl>0 && sl<e && t>e && risk>0 && rr>=minRR;
  return {ok,entry:e,stopLoss:sl,target:t,risk,reward,rr:Number.isFinite(rr)?Number(rr.toFixed(4)):null};
}

export function updateActiveSetupFromTick(setup, tick, now = Date.now()) {
  if (!setup || setup.status !== 'ACTIVE') return setup;
  if (!tick) return {...setup,feedStatus:'WAITING_FOR_TICK'};
  const receivedAt=Number(tick.receivedAt),exchangeTime=Number(tick.exchangeTime),price=Number(tick.price);
  const receiveAgeMs=now-receivedAt,exchangeReceiptDelayMs=receivedAt-exchangeTime*1000;
  const fresh=Boolean(tick.fresh && Number.isFinite(price) && price>0 && Number.isFinite(receivedAt) &&
    Number.isFinite(exchangeTime) && receiveAgeMs>=0 && receiveAgeMs<=10000 &&
    exchangeReceiptDelayMs>=0 && exchangeReceiptDelayMs<=5000);
  if (!fresh) return {...setup,feedStatus:'STALE'};
  const observed={...setup,feedStatus:'FRESH',lastObservedPrice:price,
    lastObservedExchangeTime:exchangeTime,lastObservedAt:new Date(receivedAt).toISOString()};
  if (price<=Number(setup.stopLoss)) return {...observed,status:'STOP_LOSS_HIT',exitPrice:price,closedAt:new Date(receivedAt).toISOString()};
  if (price>=Number(setup.target)) return {...observed,status:'TARGET_HIT',exitPrice:price,closedAt:new Date(receivedAt).toISOString()};
  return observed;
}
