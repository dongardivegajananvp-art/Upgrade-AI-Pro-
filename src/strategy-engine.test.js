import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, detectNineStrategySetup, evaluateNineStrategies, buildFixedPremiumPlan, canAcceptStrategyTrade, confirmBreakoutPressureVolume, analyzeSetupResearch, validateStrategyOptionContract, detectOpeningRange, detectEmaTrend, detectTopGainerMomentum, detectDayHighLowRetest, detectDoublePattern, detectContinuation, detectFlagVolume, detectDailyTrendPullback } from './strategy-engine.js';

test('exactly nine established NSE strategies are present', () => {
  assert.equal(STRATEGIES.length, 9);
  assert.deepEqual(STRATEGIES, [
    'EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK',
    'DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION',
    'BEARISH_CONTINUATION','FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT'
  ]);
});
test('scanner fails closed without a fresh exchange tick', () => {
  const result = detectNineStrategySetup({ underlyingCandles: [], underlyingTick: null, now: 1800000000000 });
  assert.equal(result.status, 'DATA_UNAVAILABLE_NO_TRADE');
});
test('fixed premium plan enforces breakout, chase block and exact 1:2', () => {
  const plan = buildFixedPremiumPlan({ breakoutLevel: 100, tickSize: 0.05, livePremium: 100.05, swingLow: 99 });
  assert.equal(plan.status, 'SETUP_CONFIRMED');
  assert.equal(plan.rr, 2);
  assert.equal(plan.entry,100.05);
  assert.equal(plan.stopLoss,98.95);
  assert.equal(plan.target,102.25);
  const aiTarget=buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:99,targetR:2.5});
  assert.equal(aiTarget.target,102.8);
  assert.equal(aiTarget.rr,2.5);
  assert.equal(buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:99,targetR:1.5}).status,'NO_TRADE');
  assert.equal(buildFixedPremiumPlan({ breakoutLevel:100,tickSize:0.05,livePremium:102,swingLow:99 }).status, 'NO_TRADE');
});
test('duplicate active underlying or option contract is rejected', () => {
  assert.equal(canAcceptStrategyTrade([], { underlying:'NSE:ABC-EQ',contract:'NSE:ABC26000CE' }).ok, true);
  assert.equal(canAcceptStrategyTrade([{underlying:'NSE:ABC-EQ',contract:'NSE:ABC26000CE'}], { underlying:'NSE:ABC-EQ',contract:'NSE:ABC26000CE' }).ok, false);
});


function pressureVolumeRows(side='LONG') {
  const rows=Array.from({length:21},(_,i)=>({time:1800000000+i*300,open:100,high:101,low:99,close:100,volume:100}));
  rows[20]=side==='LONG'
    ? {time:1800006000,open:100,high:103,low:99.5,close:102.8,volume:160}
    : {time:1800006000,open:100,high:100.5,low:97,close:97.2,volume:160};
  return rows;
}
test('common confirmation requires strong bullish pressure and at least 1.5x available prior same-session volume', () => {
  const rows=pressureVolumeRows('LONG');
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows.at(-1).time);
  assert.equal(result.ok,true);
  assert.equal(result.pressure,'BUYING');
  assert.equal(result.relativeVolume,1.6);
  assert.ok(result.bodyStrength>=0.55);
});
test('common confirmation requires strong bearish pressure and at least 1.5x available prior same-session volume', () => {
  const rows=pressureVolumeRows('SHORT');
  const result=confirmBreakoutPressureVolume(rows,'SHORT',99,rows.at(-1).time);
  assert.equal(result.ok,true);
  assert.equal(result.pressure,'SELLING');
  assert.equal(result.relativeVolume,1.6);
});
test('common confirmation rejects weak body pressure even when volume is high', () => {
  const rows=pressureVolumeRows('LONG');
  rows[20]={...rows[20],open:100,high:104,low:99,close:101.5,volume:500};
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows[20].time);
  assert.equal(result.ok,false);
  assert.match(result.reason,/Buying pressure is weak/);
});
test('common confirmation rejects volume below 1.5x the available prior same-session average', () => {
  const rows=pressureVolumeRows('LONG');
  rows[20]={...rows[20],volume:149};
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows[20].time);
  assert.equal(result.ok,false);
  assert.match(result.reason,/1.5x/);
});
test('relative-volume baseline has no 20-candle cap and uses all prior contiguous same-session candles', () => {
  const start=1800000000;
  const rows=Array.from({length:31},(_,i)=>({
    time:start+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  rows[30]={time:start+30*300,open:100,high:103,low:99.5,close:102.8,volume:160};
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows[30].time);
  assert.equal(result.ok,true);
  assert.equal(result.baselineCandleCount,30);
  assert.equal(result.averagePriorVolume,100);
  assert.equal(result.relativeVolume,1.6);
});

test('common confirmation accepts the opening 5-minute breakout with one valid same-session volume reference', () => {
  const rows=[
    {time:1800000000,open:100,high:101,low:99,close:100,volume:100},
    {time:1800000300,open:100,high:103,low:99.5,close:102.8,volume:160}
  ];
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows[1].time);
  assert.equal(result.ok,true);
  assert.equal(result.relativeVolume,1.6);
  assert.equal(result.averagePriorVolume,100);
  assert.equal(result.baselineCandleCount,1);
});

test('common confirmation rejects a missing same-session volume reference instead of inventing one', () => {
  const rows=pressureVolumeRows('LONG').slice(-1);
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows[0].time);
  assert.equal(result.ok,false);
  assert.match(result.reason,/At least one immediately preceding same-session/);
});

test('relative-volume baseline never crosses an overnight/session boundary', () => {
  const rows=[
    {time:1800000000,open:100,high:101,low:99,close:100,volume:100},
    {time:1800086700,open:100,high:103,low:99.5,close:102.8,volume:200}
  ];
  const result=confirmBreakoutPressureVolume(rows,'LONG',101,rows[1].time);
  assert.equal(result.ok,false);
  assert.match(result.reason,/same-session/);
});
test('retest cannot substitute its candle when original level cross is missing', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100.2, volume: 100 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 200 }
  ];
  const result = confirmBreakoutPressureVolume(rows, 'LONG', 105, rows[1].time, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Original breakout/);
});

test('multi-timeframe research returns an explainable score only with verified daily, 15m and 5m candles', () => {
  const now=1800000000000;
  const make=(count,step,base)=>Array.from({length:count},(_,i)=>({time:base+i*step,open:100+i,high:101+i,low:99+i,close:100.8+i,volume:100+i}));
  const five=make(60,300,now/1000-60*300),daily=make(60,86400,now/1000-60*86400),fifteen=make(60,900,now/1000-60*900);
  const setup={strategy:'EMA20_EMA50_TREND',side:'LONG',confirmedAt:five.at(-1).time,breakoutConfirmation:{pressure:'BUYING'}};
  const result=analyzeSetupResearch({candles:five,dailyCandles:daily,fifteenMinuteCandles:fifteen,tick:{exchangeTime:now/1000,receivedAt:now},setup,now});
  assert.equal(result.status,'COMPLETE');
  assert.ok(result.qualityScore>=85&&result.qualityScore<=100);
  assert.equal(result.timeframes.daily,'BULLISH');
  assert.equal(result.timeframes.fifteenMinute,'BULLISH');
  assert.ok(result.evidence.some(line=>line.includes('Breakout candle volume: verified')));
  assert.equal(result.targetR,2.5);
  assert.equal(result.targetMethod,'AI_RESEARCH_ADAPTIVE_RISK_MULTIPLE');
});
test('multi-timeframe research refuses to invent a score when 15m history is incomplete', () => {
  const now=1800000000000;
  const make=(count,step,base=1700000000)=>Array.from({length:count},(_,i)=>({time:base+i*step,open:100+i,high:101+i,low:99+i,close:100.8+i,volume:100+i}));
  const recentDaily=make(60,86400,now/1000-60*86400);
  const result=analyzeSetupResearch({candles:make(60,300),dailyCandles:recentDaily,fifteenMinuteCandles:make(12,900),tick:{exchangeTime:now/1000,receivedAt:now},setup:{side:'LONG',confirmedAt:1700017700},now});
  assert.equal(result.status,'UNAVAILABLE');
  assert.match(result.reason,/50 verified 15-minute/);
});


test('diagnostic ledger reports all nine strategies with DETECTED, REJECTED or BLOCKED and exact gate reason', () => {
  const now=1800000000000;
  const result=detectNineStrategySetup({underlyingCandles:[],underlyingTick:null,now});
  assert.equal(result.strategyLedger.length,9);
  assert.ok(result.strategyLedger.every(row=>row.status==='BLOCKED'&&row.reason));
  assert.deepEqual(result.strategyLedger.map(row=>row.strategy),STRATEGIES);
});

test('direction-aware option selection is not actionable until independent live gates pass', async () => {
  const { chooseDirectionalOption } = await import('./option-selection.js');
  const rows=[
    {symbol:'NSE:ABC100CE',option_type:'CE',strike_price:100},
    {symbol:'NSE:ABC105CE',option_type:'CE',strike_price:105},
    {symbol:'NSE:ABC100PE',option_type:'PE',strike_price:100}
  ];
  const call=chooseDirectionalOption({optionsChain:rows,underlyingPrice:104,side:'LONG'});
  const put=chooseDirectionalOption({optionsChain:rows,underlyingPrice:101,side:'SHORT'});
  assert.equal(call.side,'CE');
  assert.equal(call.strike,105);
  assert.equal(put.side,'PE');
  assert.equal(put.strike,100);
  assert.equal(call.actionable,false);
  assert.equal(chooseDirectionalOption({optionsChain:rows,underlyingPrice:104,side:'FLAT'}).status,'UNAVAILABLE');
});


test('diagnostic ledger uses strategy-specific rejection reasons when verified windows are available', () => {
  const now=Date.parse('2026-11-19T05:00:00Z');
  const start=Math.floor(now/1000)-60*300;
  const candles=Array.from({length:60},(_,i)=>({time:start+i*300,open:100,high:100.5,low:99.5,close:100,volume:100}));
  const result=detectNineStrategySetup({underlyingCandles:candles,underlyingTick:{price:100,exchangeTime:now/1000,receivedAt:now},now});
  assert.equal(result.strategyLedger.length,9);
  assert.ok(result.strategyLedger.every(row=>['DETECTED','REJECTED','BLOCKED'].includes(row.status)&&row.reason));
  assert.ok(result.strategyLedger.some(row=>row.status==='REJECTED'&&row.reason.includes('EMA20')));
  assert.ok(result.strategyLedger.some(row=>row.status==='BLOCKED'&&row.reason.includes('daily candles')));
});

test('early option entry exposes exact tick-aligned trigger while waiting inside the same 5-minute candle', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:i===49?2000:1000+i,completed:true};
  });
  const optionCandles=Array.from({length:3},(_,i)=>({
    time:start+(47+i)*300,open:103+i,high:104+i,low:102+i,close:103.5+i,volume:500+i,completed:true
  }));
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const optionTick={symbol:contract.symbol,price:105.5,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({
    underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:149.8,exchangeTime:now/1000,receivedAt:now},
    optionCandles,optionTick,contract,dailyCandles:[],fifteenMinuteCandles:[],
    isTopGainer:false,researchEnabled:false,now
  });
  assert.equal(result.status,'WAITING_FOR_OPTION_BREAKOUT');
  assert.equal(result.entryTriggerPrice,106.05);
  assert.equal(result.optionTickSize,.05);
  assert.equal(result.contract,contract.symbol);
  assert.equal(result.optionSide,'CE');
});

test('option entry requires ordered prior-range, bullish-breakout and bullish-retest candles', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
    {time:start+47*300,open:103,high:104,low:102,close:103.5,volume:500},
    {time:start+48*300,open:104,high:105,low:103,close:104.5,volume:510},
    {time:start+49*300,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const base={underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:149.8,exchangeTime:now/1000,receivedAt:now},
    optionTick:{symbol:contract.symbol,price:105.5,exchangeTime:now/1000,receivedAt:now},
    contract,optionCandles,dailyCandles:[],fifteenMinuteCandles:[],researchEnabled:false,now};
  const valid=evaluateNineStrategies(base);
  assert.equal(valid.status,'WAITING_FOR_OPTION_BREAKOUT');
  assert.equal(valid.entryTriggerPrice,106.05);
  const invalid=evaluateNineStrategies({...base,optionCandles:[
    optionCandles[0],optionCandles[1],
    {...optionCandles[2],low:102.5,close:103,open:104}
  ]});
  assert.equal(invalid.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(invalid.reason,/confirmation candle must retest/i);
});

test('confirmed option entry returns Entry/SL/Target/RR and the retest candle timestamp', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
    {time:start+47*300,open:103,high:104,low:102,close:103.5,volume:500},
    {time:start+48*300,open:104,high:105,low:103,close:104.5,volume:510},
    {time:start+49*300,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:149.8,exchangeTime:now/1000,receivedAt:now},
    optionCandles,
    optionTick:{symbol:contract.symbol,price:106.05,exchangeTime:now/1000,receivedAt:now},
    contract,dailyCandles:[],fifteenMinuteCandles:[],researchEnabled:false,now
  });
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.optionCandleTime,optionCandles[2].time);
  assert.equal(result.entry,106.05);
  assert.equal(result.stopLoss,103.95);
  assert.equal(result.rr,2);
  assert.equal(result.optionConfirmation,'COMPLETED_BULLISH_BREAKOUT_RETEST');
});

test('non-retest strategies validate pressure on the trigger candle, not an older level cross', () => {
  const rows=Array.from({length:22},(_,i)=>({time:1800000000+i*300,open:100,high:101,low:99,close:100,volume:100}));
  rows[20]={time:1800006000,open:100,high:103,low:99.5,close:102.8,volume:200};
  rows[21]={time:1800006300,open:103,high:103.5,low:102,close:102.5,volume:150};
  const nonRetest=confirmBreakoutPressureVolume(rows,'LONG',101,rows[21].time,false);
  assert.equal(nonRetest.ok,false);
  assert.match(nonRetest.reason,/Buying pressure is weak/);

  const retest=confirmBreakoutPressureVolume(rows,'LONG',101,rows[21].time,true);
  assert.equal(retest.ok,true);
  assert.equal(retest.candleTime,rows[20].time);
});


test('top-gainer breakout uses two contiguous candles and no fixed 20-candle volume warm-up', () => {
  const now=1800006901000;
  const start=Math.floor(now/1000)-2*300;
  const underlyingCandles=Array.from({length:2},(_,i)=>i===1
    ? {time:start+i*300,open:100,high:103,low:99.8,close:102.5,volume:250}
    : {time:start+i*300,open:100,high:101,low:99,close:100,volume:100});
  const result=detectNineStrategySetup({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:102.1,exchangeTime:now/1000,receivedAt:now},
    isTopGainer:true,researchEnabled:false,now
  });
  assert.equal(result.status,'UNDERLYING_SETUP_CONFIRMED');
  assert.equal(result.strategy,'TOP_GAINER_MOMENTUM_BREAKOUT');
  const topGainer=result.strategyLedger.find(row=>row.strategy==='TOP_GAINER_MOMENTUM_BREAKOUT');
  assert.equal(topGainer.status,'DETECTED');
  assert.ok(result.strategyLedger.some(row=>row.strategy==='EMA20_EMA50_TREND'&&row.status==='BLOCKED'));
  assert.ok(result.strategyLedger.some(row=>row.strategy==='DAILY_TREND_5M_PULLBACK'&&row.status==='BLOCKED'));
});


test('top-gainer scanner fails closed on a gap, duplicate, or reversed completed 5-minute window', () => {
  const now=1800006900000;
  const base=Math.floor(now/1000)-2*300;
  const baseline=[{time:base,open:100,high:101,low:99,close:100,volume:100}];
  const breakout={time:base+300,open:100,high:103,low:99.8,close:102,volume:250};
  const tick={symbol:'NSE:ABC-EQ',price:102.1,exchangeTime:now/1000,receivedAt:now};
  const variants=[
    [{...baseline[0],time:base+300},breakout],
    [{...baseline[0],time:base-300},breakout],
    [breakout,...baseline]
  ];
  for(const underlyingCandles of variants){
    const result=detectNineStrategySetup({underlyingCandles,underlyingTick:tick,isTopGainer:true,researchEnabled:false,now});
    assert.notEqual(result.status,'UNDERLYING_SETUP_CONFIRMED');
    assert.ok(result.status==='DATA_UNAVAILABLE_NO_TRADE'||result.status==='NO_TRADE');
  }
});

test('option premium gate rejects a missing 5-minute candle even when the latest quote is fresh', () => {
  const now=1800006300000;
  const underlyingCandles=Array.from({length:21},(_,i)=>i===20
    ? {time:1800006000,open:100,high:103,low:99.5,close:102.8,volume:250}
    : {time:1800000000+i*300,open:100,high:101,low:99,close:100,volume:100});
  const optionCandles=[
    {time:1800005100,open:103,high:104,low:102,close:103.5,volume:500},
    {time:1800005400,open:104,high:105,low:103,close:104.5,volume:510},
    {time:1800006000,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05,expiry:now/1000+7*86400,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:102.1,exchangeTime:now/1000,receivedAt:now},
    optionCandles,
    optionTick:{symbol:contract.symbol,price:106.1,exchangeTime:now/1000,receivedAt:now},
    contract,isTopGainer:true,researchEnabled:false,now
  });
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/3 contiguous completed 5-minute candles/i);
});

test('opening-range setup confirms first breakout after the opening candle without a 20-candle warm-up', () => {
  const start=Date.parse('2026-11-20T03:45:00Z')/1000; // 09:15 IST
  const baseline=[{time:start,open:100,high:101,low:99,close:100,volume:100}];
  const breakout={time:start+300,open:100,high:103,low:99.5,close:102.5,volume:200};
  const setup=detectOpeningRange([...baseline,breakout],555,103);
  assert.equal(setup.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(setup.side,'LONG');
  const confirmation=confirmBreakoutPressureVolume([...baseline,breakout],'LONG',101,breakout.time);
  assert.equal(confirmation.ok,true);
  assert.equal(confirmation.pressure,'BUYING');
  assert.equal(confirmation.breakoutVolume,200);
  assert.equal(confirmation.relativeVolume,2);
  assert.equal(confirmation.baselineCandleCount,1);
});

test('breakout candle confirmation enforces directional pressure and relative volume', () => {
  const bullishRows=pressureVolumeRows('LONG');
  const bearishRows=pressureVolumeRows('SHORT');
  assert.equal(confirmBreakoutPressureVolume(bullishRows,'LONG',101,bullishRows.at(-1).time).ok,true);
  assert.equal(confirmBreakoutPressureVolume(bearishRows,'SHORT',99,bearishRows.at(-1).time).ok,true);
  const noVolume=pressureVolumeRows('LONG'); noVolume[20]={...noVolume[20],volume:0};
  assert.equal(confirmBreakoutPressureVolume(noVolume,'LONG',101,noVolume[20].time).ok,false);
  const weak=pressureVolumeRows('LONG'); weak[20]={...weak[20],close:100.5};
  assert.equal(confirmBreakoutPressureVolume(weak,'LONG',101,weak[20].time).ok,false);
});


// Direct detector fixtures supplement the aggregate ledger tests. These
// fixtures exercise representative positive and negative paths without
// relaxing the common freshness, candle-continuity or option-entry gates.
test('EMA20/EMA50 detector accepts aligned bullish trend and rejects flat history', () => {
  const rows=Array.from({length:50},(_,i)=>({time:1800000000+i*300,open:100+i*.1,high:100.2+i*.1,low:99.9+i*.1,close:100.1+i*.1,volume:100}));
  assert.equal(detectEmaTrend(rows)?.side,'LONG');
  const flat=rows.map(c=>({...c,open:100,high:101,low:99,close:100}));
  assert.equal(detectEmaTrend(flat),null);
});

test('Top Gainer detector requires verified leaderboard membership and completed-candle breakout', () => {
  const rows=[
    {time:1800000000,open:100,high:101,low:99,close:100,volume:100},
    {time:1800000300,open:100,high:103,low:99.5,close:102,volume:200}
  ];
  assert.equal(detectTopGainerMomentum(rows,false),null);
  assert.equal(detectTopGainerMomentum(rows,true)?.side,'LONG');
  assert.equal(detectTopGainerMomentum(rows.slice(0,1),true),null);
});

test('day high/low retest detector confirms only after a close-through and retest hold', () => {
  const start=Date.parse('2026-11-20T03:45:00Z')/1000;
  const rows=[
    {time:start,open:100,high:101,low:99,close:100,volume:100},
    {time:start+300,open:100.5,high:102,low:100,close:101.5,volume:160},
    {time:start+600,open:101.5,high:103,low:101,close:102.5,volume:170},
    {time:start+900,open:101.2,high:102,low:100.9,close:101.7,volume:180}
  ];
  assert.equal(detectDayHighLowRetest(rows)?.side,'LONG');
  assert.equal(detectDayHighLowRetest(rows.slice(0,3)),null);
});

test('double top/bottom detector rejects flat and incomplete swing structures', () => {
  const rows=Array.from({length:48},(_,i)=>({time:1800000000+i*300,open:100,high:101,low:99,close:100,volume:100}));
  assert.equal(detectDoublePattern(rows),null);
  assert.equal(detectDoublePattern(rows.slice(0,20)),null);
});

test('bullish and bearish continuation detectors require impulse, consolidation and breakout', () => {
  const make=(side)=>{
    const rows=[];
    for(let i=0;i<17;i++){
      const close=side==='LONG'?100+i:120-i;
      rows.push({time:1800000000+i*300,open:close-.2,high:close+.2,low:close-.4,close,volume:200});
    }
    for(let i=0;i<12;i++){
      const base=side==='LONG'?116:104;
      rows.push({time:1800005100+i*300,open:base,high:base+.5,low:base-.5,close:base+.1,volume:100});
    }
    const base=side==='LONG'?116:104;
    rows.push(side==='LONG'
      ?{time:1800008700,open:base+.5,high:base+2,low:base+.4,close:base+1.5,volume:250}
      :{time:1800008700,open:base-.5,high:base-.4,low:base-2,close:base-1.5,volume:250});
    return rows;
  };
  assert.equal(detectContinuation(make('LONG'),'LONG')?.side,'LONG');
  assert.equal(detectContinuation(make('SHORT'),'SHORT')?.side,'SHORT');
  const flat=make('LONG').map(c=>({...c,open:100,high:101,low:99,close:100}));
  assert.equal(detectContinuation(flat,'LONG'),null);
});

test('flag-volume detector requires contracting flag volume and a high-volume breakout', () => {
  const rows=[];
  for(let i=0;i<17;i++){
    const close=100+i;
    rows.push({time:1800000000+i*300,open:close-.2,high:close+.2,low:close-.4,close,volume:200});
  }
  for(let i=0;i<12;i++)rows.push({time:1800005100+i*300,open:116,high:117,low:115,close:116,volume:100});
  rows.push({time:1800008700,open:117,high:120,low:116.8,close:119,volume:200});
  assert.equal(detectFlagVolume(rows)?.side,'LONG');
  assert.equal(detectFlagVolume(rows.map(c=>({...c,volume:200}))),null);
});

test('daily-trend pullback detector blocks missing or stale daily context', () => {
  const rows=Array.from({length:50},(_,i)=>({time:1800000000+i*300,open:100+i*.1,high:100.2+i*.1,low:99.9+i*.1,close:100.1+i*.1,volume:100}));
  assert.equal(detectDailyTrendPullback(rows,[],1800000000000),null);
});


test('double-top and double-bottom detectors require a neckline break followed by a retest',()=>{
  const start=1800000000;
  const top=Array.from({length:20},(_,i)=>({time:start+i*300,open:100,high:101,low:100,close:100,volume:100}));
  top[5]={...top[5],open:108,high:110,low:105,close:109};
  top[12]={...top[12],open:108,high:110,low:105,close:109};
  top[15]={...top[15],close:99.5};
  top[17]={...top[17],close:99.6};
  top[18]={...top[18],close:99.5};
  top[19]={...top[19],high:100.2,low:98.8,close:99.5};
  const doubleTop=detectDoublePattern(top);
  assert.equal(doubleTop?.side,'SHORT');
  assert.equal(doubleTop?.pattern,'DOUBLE_TOP');

  const bottom=Array.from({length:20},(_,i)=>({time:start+i*300,open:100,high:100,low:99,close:100,volume:100}));
  bottom[5]={...bottom[5],open:92,high:95,low:90,close:91};
  bottom[12]={...bottom[12],open:92,high:95,low:90,close:91};
  bottom[15]={...bottom[15],close:100.5};
  bottom[17]={...bottom[17],close:100.6};
  bottom[18]={...bottom[18],close:100.5};
  bottom[19]={...bottom[19],high:101.2,low:99.8,close:100.5};
  const doubleBottom=detectDoublePattern(bottom);
  assert.equal(doubleBottom?.side,'LONG');
  assert.equal(doubleBottom?.pattern,'DOUBLE_BOTTOM');
});


test('daily-trend 5m pullback detector confirms bullish EMA alignment and resume after a pullback touch',()=>{
  const now=Date.parse('2026-11-23T12:00:00Z');
  const start=Math.floor(now/1000)-60*300;
  const rows=Array.from({length:60},(_,i)=>{
    const close=100+i*.2;
    return{time:start+i*300,open:close-.05,high:close+.1,low:close-.1,close,volume:100};
  });
  rows[58]={time:start+58*300,open:109.05,high:109.15,low:108.7,close:108.9,volume:120};
  rows[59]={time:start+59*300,open:109.1,high:109.7,low:109,close:109.6,volume:150};
  const dailyStart=Math.floor(now/1000)-60*86400;
  const daily=Array.from({length:60},(_,i)=>{
    const close=100+i;
    return{time:dailyStart+i*86400,open:close-.2,high:close+.5,low:close-.5,close,volume:1000};
  });
  const result=detectDailyTrendPullback(rows,daily,now);
  assert.equal(result?.side,'LONG');
  assert.equal(result?.strategy,'DAILY_TREND_5M_PULLBACK');
});


test('confirmed bearish underlying setup validates a PE contract and fixed Entry/SL/Target/RR', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=200-i,close=open-1.2;
    return {time:start+i*300,open,high:open+.1,low:close-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
    {time:start+47*300,open:103,high:104,low:102,close:103.5,volume:500},
    {time:start+48*300,open:104,high:105,low:103,close:104.5,volume:510},
    {time:start+49*300,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150PE',underlying:'ABC',side:'PE',tickSize:.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-PE-150'};
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:149.8,exchangeTime:now/1000,receivedAt:now},
    optionCandles,
    optionTick:{symbol:contract.symbol,price:106.05,exchangeTime:now/1000,receivedAt:now},
    contract,dailyCandles:[],fifteenMinuteCandles:[],researchEnabled:false,now
  });
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.equal(result.contract,contract.symbol);
  assert.equal(result.entry,106.05);
  assert.equal(result.stopLoss,103.95);
  assert.equal(result.rr,2);
  assert.ok(result.rr>=2);
});

test('all nine strategies enforce the full LONG/CE and SHORT/PE contract-side matrix', () => {
  for(const strategy of STRATEGIES){
    const now=Date.parse('2026-11-19T08:00:00Z');
    const base={underlying:'ABC',expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'FY123',tickSize:0.05};
    const longCe=validateStrategyOptionContract({strategy,underlyingSide:'LONG',underlyingSymbol:'NSE:ABC-EQ',now,contract:{...base,symbol:'NSE:ABC26NOV150CE',side:'CE'}});
    const longPe=validateStrategyOptionContract({strategy,underlyingSide:'LONG',underlyingSymbol:'NSE:ABC-EQ',now,contract:{...base,symbol:'NSE:ABC26NOV150PE',side:'PE'}});
    const shortPe=validateStrategyOptionContract({strategy,underlyingSide:'SHORT',underlyingSymbol:'NSE:ABC-EQ',now,contract:{...base,symbol:'NSE:ABC26NOV150PE',side:'PE'}});
    const shortCe=validateStrategyOptionContract({strategy,underlyingSide:'SHORT',underlyingSymbol:'NSE:ABC-EQ',now,contract:{...base,symbol:'NSE:ABC26NOV150CE',side:'CE'}});
    assert.equal(longCe.ok,true,strategy+' LONG must accept CE');
    assert.equal(longPe.ok,false,strategy+' LONG must reject PE');
    assert.equal(shortPe.ok,true,strategy+' SHORT must accept PE');
    assert.equal(shortCe.ok,false,strategy+' SHORT must reject CE');
  }
});
test('directional contract matrix rejects unknown strategy, absent side, invalid tick size and non-NSE symbol', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const valid={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:0.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'FY123'};
  const args={strategy:STRATEGIES[0],underlyingSide:'LONG',underlyingSymbol:'NSE:ABC-EQ',now,contract:valid};
  assert.equal(validateStrategyOptionContract({...args,strategy:'UNKNOWN'}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,underlyingSide:'FLAT'}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,tickSize:0}}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,symbol:'BSE:ABC26NOV150CE'}}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,underlying:'XYZ'}}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,underlyingSymbol:'NSE:XYZ-EQ'}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,expiry:now/1000-1}}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,strike:0}}).ok,false);
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,fyToken:''}}).ok,false);
});


function makeTopGainerEndToEndCase() {
  const now=Date.parse('2026-11-19T04:01:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=[
    {time:start+300,open:100,high:101,low:99,close:100,volume:100},
    {time:start+600,open:101,high:104,low:100.8,close:103.8,volume:200}
  ];
  const optionCandles=[
    {time:start,open:103,high:104,low:102,close:103.5,volume:500},
    {time:start+300,open:104,high:105,low:103,close:104.5,volume:510},
    {time:start+600,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={
    symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:0.05,
    expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-CE-150'
  };
  return {
    now,underlyingCandles,optionCandles,contract,isTopGainer:true,researchEnabled:false,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:103.8,exchangeTime:now/1000,receivedAt:now},
    optionTick:{symbol:contract.symbol,price:106.05,exchangeTime:now/1000,receivedAt:now}
  };
}

test('end-to-end Top Gainer LONG setup passes underlying, CE contract, live option retest and fixed risk gates',()=>{
  const input=makeTopGainerEndToEndCase();
  const result=evaluateNineStrategies(input);
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'TOP_GAINER_MOMENTUM_BREAKOUT');
  assert.equal(result.underlyingSide,'LONG');
  assert.equal(result.optionSide,'CE');
  assert.equal(result.entry,106.05);
  assert.equal(result.stopLoss,103.95);
  assert.equal(result.target,110.25);
  assert.ok(result.rr>=2);
  assert.equal(result.strategyLedger.find(row=>row.strategy==='TOP_GAINER_MOMENTUM_BREAKOUT').status,'DETECTED');
});

test('end-to-end Top Gainer pipeline fails closed when option quote is stale or absent',()=>{
  const input=makeTopGainerEndToEndCase();
  const stale=evaluateNineStrategies({...input,optionTick:{...input.optionTick,receivedAt:input.now-11000}});
  assert.equal(stale.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(stale.reason,/Fresh FYERS option premium tick/);
  const absent=evaluateNineStrategies({...input,optionTick:null});
  assert.equal(absent.status,'DATA_UNAVAILABLE_NO_TRADE');
});

test('end-to-end Top Gainer pipeline rejects wrong option direction and incomplete option candle history',()=>{
  const input=makeTopGainerEndToEndCase();
  const wrongSide=evaluateNineStrategies({...input,contract:{...input.contract,side:'PE',symbol:'NSE:ABC26NOV150PE'}});
  assert.equal(wrongSide.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(wrongSide.reason,/option side does not match/);
  const missingCandle=evaluateNineStrategies({...input,optionCandles:input.optionCandles.slice(1)});
  assert.equal(missingCandle.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(missingCandle.reason,/3 contiguous completed 5-minute candles/);
});

test('end-to-end Top Gainer pipeline waits below premium trigger and blocks chasing beyond 0.5R',()=>{
  const input=makeTopGainerEndToEndCase();
  const waiting=evaluateNineStrategies({...input,optionTick:{...input.optionTick,price:106.0}});
  assert.equal(waiting.status,'WAITING_FOR_OPTION_BREAKOUT');
  assert.equal(waiting.entryTriggerPrice,106.05);
  const chased=evaluateNineStrategies({...input,optionTick:{...input.optionTick,price:107.2}});
  assert.equal(chased.status,'NO_TRADE');
  assert.match(chased.reason,/more than 0.5R/);
});


function makeOptionPipelineFields(start, side='CE') {
  const symbol='NSE:ABC26NOV150'+side;
  const contract={symbol,underlying:'ABC',side,tickSize:0.05,
    expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-'+side+'-150'};
  const optionCandles=[
    {time:start,open:103,high:104,low:102,close:103.5,volume:500},
    {time:start+300,open:104,high:105,low:103,close:104.5,volume:510},
    {time:start+600,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  return {contract,optionCandles,optionTick:{symbol,price:106.05,exchangeTime:start/1+900,receivedAt:(start+900)*1000}};
}

test('end-to-end day-high breakout/retest reaches fixed-risk plan only after original breakout pressure/volume confirms',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, now=(start+1500)*1000;
  const underlyingCandles=[
    {time:start,open:100,high:101,low:99,close:100,volume:100},
    {time:start+300,open:100,high:102,low:99.5,close:101.8,volume:200},
    {time:start+600,open:101.5,high:103,low:101,close:102.5,volume:170},
    {time:start+900,open:101.2,high:102,low:100.9,close:101.7,volume:180}
  ];
  const option=makeOptionPipelineFields(start+300,'CE');
  option.optionTick={...option.optionTick,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:101.7,exchangeTime:now/1000,receivedAt:now},...option,now,researchEnabled:false});
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'DAY_HIGH_LOW_BREAK_RETEST');
  assert.equal(result.underlyingSide,'LONG');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
});

test('end-to-end opening-range first-candle breakout passes only with completed pressure/volume and option confirmation',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, now=(start+900)*1000;
  const underlyingCandles=[
    {time:start,open:100,high:101,low:99,close:100,volume:100},
    {time:start+300,open:100,high:103,low:99.5,close:102.8,volume:200}
  ];
  const option=makeOptionPipelineFields(start-300,'CE');
  option.optionCandles=option.optionCandles.map((c,i)=>({...c,time:start-300+i*300}));
  option.optionTick={...option.optionTick,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:102.8,exchangeTime:now/1000,receivedAt:now},...option,now,researchEnabled:false});
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(result.underlyingSide,'LONG');
  assert.ok(result.rr>=2);
});


function evaluateUnderlyingFixture(underlyingCandles, side='LONG', extra={}) {
  const lastTime=underlyingCandles.at(-1).time;
  const now=(lastTime+360)*1000;
  const optionStart=lastTime-600;
  const option=makeOptionPipelineFields(optionStart,side==='LONG'?'CE':'PE');
  option.optionTick={...option.optionTick,exchangeTime:now/1000,receivedAt:now};
  return evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:underlyingCandles.at(-1).close,exchangeTime:now/1000,receivedAt:now},
    ...option,now,researchEnabled:false,...extra
  });
}

test('end-to-end bullish continuation validates the complete LONG→CE→risk-plan pipeline',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, rows=[];
  for(let i=0;i<17;i++){const close=100+i;rows.push({time:start+i*300,open:close-.2,high:close+.3,low:close-.3,close,volume:200});}
  for(let i=0;i<12;i++)rows.push({time:start+(17+i)*300,open:107.2,high:108,low:106,close:107.2,volume:100});
  rows.push({time:start+29*300,open:108.2,high:109.5,low:108.1,close:109,volume:400});
  const result=evaluateUnderlyingFixture(rows,'LONG');
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'BULLISH_CONTINUATION');
  assert.equal(result.underlyingSide,'LONG');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
});

test('end-to-end bearish continuation validates the complete SHORT→PE→risk-plan pipeline',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, rows=[];
  for(let i=0;i<17;i++){const close=120-i;rows.push({time:start+i*300,open:close+.2,high:close+.3,low:close-.3,close,volume:200});}
  for(let i=0;i<12;i++)rows.push({time:start+(17+i)*300,open:104,high:104.5,low:103.5,close:104,volume:100});
  rows.push({time:start+29*300,open:103.4,high:103.6,low:101,close:101.5,volume:400});
  const result=evaluateUnderlyingFixture(rows,'SHORT');
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'BEARISH_CONTINUATION');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.ok(result.rr>=2);
});

test('end-to-end flag-volume breakout is independently selectable when continuation impulse threshold is not met',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, rows=[];
  for(let i=0;i<17;i++){const close=100+i*.6;rows.push({time:start+i*300,open:close-.2,high:close+.3,low:close-.3,close,volume:200});}
  for(let i=0;i<12;i++)rows.push({time:start+(17+i)*300,open:108,high:112,low:104,close:108,volume:100});
  rows.push({time:start+29*300,open:111,high:113.5,low:110.8,close:113.2,volume:400});
  const result=evaluateUnderlyingFixture(rows,'LONG');
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'FLAG_BREAKOUT_VOLUME');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
});

test('end-to-end daily-trend pullback requires fresh daily context and completes the SHORT/PE risk plan',()=>{
  const now=Date.parse('2026-11-23T12:00:00Z'), start=Math.floor(now/1000)-60*300;
  const rows=Array.from({length:60},(_,i)=>{
    const close=200-i*.2;
    return{time:start+i*300,open:close+.05,high:close+.1,low:close-.1,close,volume:100};
  });
  rows[58]={time:start+58*300,open:190,high:190.2,low:189.9,close:190.05,volume:120};
  rows[59]={time:start+59*300,open:189.8,high:189.85,low:189.2,close:189.3,volume:220};
  const dailyStart=Math.floor(now/1000)-60*86400;
  const daily=Array.from({length:60},(_,i)=>{
    const close=300-i;
    return{time:dailyStart+i*86400,open:close+.2,high:close+.5,low:close-.5,close,volume:1000};
  });
  const lastTime=rows.at(-1).time, evaluationNow=(lastTime+360)*1000;
  const option=makeOptionPipelineFields(lastTime-600,'PE');
  option.optionTick={...option.optionTick,exchangeTime:evaluationNow/1000,receivedAt:evaluationNow};
  const base={underlyingCandles:rows,underlyingTick:{symbol:'NSE:ABC-EQ',price:189.3,exchangeTime:evaluationNow/1000,receivedAt:evaluationNow},...option,dailyCandles:daily,now:evaluationNow,researchEnabled:false};
  const result=evaluateNineStrategies(base);
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'DAILY_TREND_5M_PULLBACK');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.ok(result.rr>=2);
  const missingDaily=evaluateNineStrategies({...base,dailyCandles:[]});
  assert.notEqual(missingDaily.strategy,'DAILY_TREND_5M_PULLBACK');
  assert.equal(missingDaily.strategyLedger.find(row=>row.strategy==='DAILY_TREND_5M_PULLBACK').status,'BLOCKED');
});
