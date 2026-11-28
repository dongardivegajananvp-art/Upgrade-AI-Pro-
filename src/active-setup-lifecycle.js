export function validateFixedRiskPlan({ entry, stopLoss, target, minRR = 2, tickSize = null } = {}) {
  const e=Number(entry), sl=Number(stopLoss), t=Number(target);
  const risk=e-sl, reward=t-e;
  const rr=reward/risk;
  const prices=[e,sl,t];
  const tick=Number(tickSize);
  const tickAligned=tickSize===null||tickSize===undefined||
    (Number.isFinite(tick)&&tick>0&&prices.every(price=>Math.abs(price/tick-Math.round(price/tick))<=1e-7));
  const ok=[e,sl,t,minRR].every(Number.isFinite) && e>0 && sl>0 && sl<e && t>e && risk>0 && rr>=minRR && tickAligned;
  return {ok,entry:e,stopLoss:sl,target:t,risk,reward,rr:Number.isFinite(rr)?Number(rr.toFixed(4)):null,tickAligned};
}

export function updateActiveSetupFromTick(setup, tick, now = Date.now()) {
  if (!setup || setup.status !== 'ACTIVE') return setup;
  if (!tick) return {...setup,feedStatus:'WAITING_FOR_TICK'};
  if (setup.contract && tick.symbol !== setup.contract) return {...setup,feedStatus:'STALE'};
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
