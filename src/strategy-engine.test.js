import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, detectNineStrategySetup, evaluateNineStrategies, buildFixedPremiumPlan, canAcceptStrategyTrade, confirmStrategyTriggerCandle, analyzeSetupResearch, validateStrategyOptionContract, detectOpeningRange, detectEmaTrend, detectTopGainerMomentum, detectDayHighLowRetest, detectDoublePattern, detectContinuation, detectFlagPriceStructure, detectDailyTrendPullback, needsDailyTrendPullbackHistory } from './strategy-engine.js';

test('exactly nine established NSE strategies are present', () => {
  assert.equal(STRATEGIES.length, 9);
  assert.deepEqual(STRATEGIES, [
    'EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK',
    'DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION',
    'BEARISH_CONTINUATION','FLAG_BREAKOUT_PRICE_STRUCTURE','OPENING_RANGE_BREAKOUT'
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


function makeDailyCandles(now,direction='LONG',count=60){
 const d=new Date(now);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-1);while(d.getUTCDay()===0||d.getUTCDay()===6)d.setUTCDate(d.getUTCDate()-1);
 const days=[];while(days.length<count){if(d.getUTCDay()!==0&&d.getUTCDay()!==6)days.push(new Date(d));d.setUTCDate(d.getUTCDate()-1);}days.reverse();
 return days.map((day,i)=>{const close=direction==='LONG'?100+i:300-i;return{time:day.getTime()/1000,open:close-.2,high:close+.5,low:close-.5,close,volume:1000};});
}
function candleRows(side='LONG') {
  const rows=Array.from({length:21},(_,i)=>({time:1800000000+i*300,open:100,high:101,low:99,close:100,volume:100}));
  rows[20]=side==='LONG'
    ? {time:1800006000,open:100,high:103,low:99.5,close:102.8,volume:160}
    : {time:1800006000,open:100,high:100.5,low:97,close:97.2,volume:160};
  return rows;
}
test('strategy trigger ignores candle pressure and volume entirely',()=>{
  const rows=candleRows('LONG');
  rows[20]={...rows[20],open:100,high:104,low:99,close:100.5,volume:0};
  const result=confirmStrategyTriggerCandle(rows,'LONG',101,rows[20].time);
  assert.equal(result.ok,true);
  assert.equal(result.candleTime,rows[20].time);
  assert.equal('relativeVolume' in result,false);
  assert.equal('pressure' in result,false);
});
test('retest trigger still requires original completed-candle price-level cross',()=>{
  const rows=candleRows('LONG');
  rows[20]={...rows[20],open:100,high:103,low:99.5,close:102.8,volume:0};
  rows[21]={time:1800006300,open:103,high:103.5,low:102,close:102.5,volume:0};
  const retest=confirmStrategyTriggerCandle(rows,'LONG',101,rows[21].time,true);
  assert.equal(retest.ok,true);
  assert.equal(retest.candleTime,rows[20].time);
  const missing=confirmStrategyTriggerCandle(rows,'LONG',105,rows[21].time,true);
  assert.equal(missing.ok,false);
});

test('15m and 5m research returns an explainable score without any daily candles', () => {
  const now=1800000000000;
  const make=(count,step,base)=>Array.from({length:count},(_,i)=>({time:base+i*step,open:100+i,high:101+i,low:99+i,close:100.8+i,volume:100+i}));
  const five=make(60,300,now/1000-60*300),fifteen=make(60,900,now/1000-60*900);
  const setup={strategy:'EMA20_EMA50_TREND',side:'LONG',confirmedAt:five.at(-1).time};
  const result=analyzeSetupResearch({candles:five,fifteenMinuteCandles:fifteen,tick:{exchangeTime:now/1000,receivedAt:now},setup,now});
  for(const row of [...five,...fifteen]) delete row.volume;
  assert.equal(result.status,'COMPLETE');
  assert.ok(result.qualityScore>=85&&result.qualityScore<=100);
  assert.equal(result.timeframes.fifteenMinute,'BULLISH');
  assert.ok(result.evidence.some(line=>line.includes('Completed-candle strategy structure: verified')));
  assert.equal('directionalPressure' in result.points,false);
  assert.equal('breakoutVolume' in result.points,false);
  assert.equal(result.targetR,2.5);
  assert.equal(result.targetMethod,'15M_5M_RESEARCH_ADAPTIVE_RISK_MULTIPLE');
});
test('multi-timeframe research refuses to invent a score when 15m history is incomplete', () => {
  const now=1800000000000;
  const make=(count,step,base=1700000000)=>Array.from({length:count},(_,i)=>({time:base+i*step,open:100+i,high:101+i,low:99+i,close:100.8+i,volume:100+i}));
  const result=analyzeSetupResearch({candles:make(60,300),fifteenMinuteCandles:make(12,900),tick:{exchangeTime:now/1000,receivedAt:now},setup:{side:'LONG',confirmedAt:1700017700},now});
  assert.equal(result.status,'UNAVAILABLE');
  assert.match(result.reason,/50 fresh, contiguous completed 15-minute/);
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
  assert.ok(result.strategyLedger.every(row=>['DETECTED','REJECTED','BLOCKED','SKIPPED_AFTER_FIRST_PASS'].includes(row.status)&&row.reason));
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
  const optionCandles=Array.from({length:1},(_,i)=>({
    time:start+(49+i)*300,open:105,high:106,low:104,close:105.5,volume:520,completed:true
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

test('option entry requires one fresh completed bullish candle and a live premium break', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
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
    {...optionCandles[0],low:102.5,close:103,open:104}
  ]});
  assert.equal(invalid.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(invalid.reason,/latest completed option 5-minute candle must close bullish/i);
});

test('confirmed option entry returns Entry/SL/Target/RR and the single confirmation candle timestamp', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
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
  assert.equal(result.optionCandleTime,optionCandles[0].time);
  assert.equal(result.entry,106.05);
  assert.equal(result.stopLoss,103.95);
  assert.equal(result.rr,2);
  assert.equal(result.optionConfirmation,'ONE_COMPLETED_BULLISH_5M_CANDLE_PLUS_LIVE_BREAKOUT');
  assertStaleOptionQuoteBlocks(underlyingCandles,'LONG','EMA20_EMA50_TREND');
});

test('confirmed PE entry supports a bearish underlying with one bullish option candle and 2R', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=200-i*1.2,close=open-1.2;
    return {time:start+i*300,open,high:open+.1,low:close-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
    {time:start+49*300,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150PE',underlying:'ABC',side:'PE',tickSize:.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-PE-150'};
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:139.8,exchangeTime:now/1000,receivedAt:now},
    optionCandles,
    optionTick:{symbol:contract.symbol,price:106.05,exchangeTime:now/1000,receivedAt:now},
    contract,dailyCandles:[],fifteenMinuteCandles:[],researchEnabled:false,now
  });
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'EMA20_EMA50_TREND');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.equal(result.entry,106.05);
  assert.equal(result.rr,2);
  assert.equal(result.optionConfirmation,'ONE_COMPLETED_BULLISH_5M_CANDLE_PLUS_LIVE_BREAKOUT');
});

test('research-enabled entry remains blocked until fresh 15-minute and 5-minute context is complete', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i*1.2,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
    {time:start+49*300,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05,expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:159.8,exchangeTime:now/1000,receivedAt:now},
    optionCandles,
    optionTick:{symbol:contract.symbol,price:106.05,exchangeTime:now/1000,receivedAt:now},
    contract,dailyCandles:[],fifteenMinuteCandles:[],researchEnabled:true,now
  });
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/50 fresh, contiguous completed 15-minute candles/i);
  assert.equal(result.entry,undefined);
  assert.equal(result.stopLoss,undefined);
  assert.equal(result.target,undefined);
});

test('non-retest strategies validate their trigger candle without pressure or volume gates', () => {
  const rows=Array.from({length:22},(_,i)=>({time:1800000000+i*300,open:100,high:101,low:99,close:100,volume:100}));
  rows[20]={time:1800006000,open:100,high:103,low:99.5,close:102.8,volume:200};
  rows[21]={time:1800006300,open:103,high:103.5,low:102,close:102.5,volume:150};
  const nonRetest=confirmStrategyTriggerCandle(rows,'LONG',101,rows[21].time,false);
  assert.equal(nonRetest.ok,true);

  const retest=confirmStrategyTriggerCandle(rows,'LONG',101,rows[21].time,true);
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
  assert.equal(result.strategyLedger.filter(row=>row.status==='DETECTED').length,1);
  assert.ok(result.strategyLedger.filter(row=>row.strategy!=='TOP_GAINER_MOMENTUM_BREAKOUT').every(row=>['BLOCKED','SKIPPED_AFTER_FIRST_PASS'].includes(row.status)));
  assert.ok(result.strategyLedger.some(row=>row.strategy==='EMA20_EMA50_TREND'&&row.status==='SKIPPED_AFTER_FIRST_PASS'));
  assert.ok(result.strategyLedger.some(row=>row.strategy==='DAILY_TREND_5M_PULLBACK'&&row.status==='SKIPPED_AFTER_FIRST_PASS'));
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
    {time:1800006000,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05,expiry:now/1000+7*86400,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:102.1,exchangeTime:now/1000,receivedAt:now},
    optionCandles:[],
    optionTick:{symbol:contract.symbol,price:106.1,exchangeTime:now/1000,receivedAt:now},
    contract,isTopGainer:true,researchEnabled:false,now
  });
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/latest completed candle is stale/i);
});

test('opening-range setup confirms first breakout after the opening candle without a 20-candle warm-up', () => {
  const start=Date.parse('2026-11-20T03:45:00Z')/1000; // 09:15 IST
  const baseline=[{time:start,open:100,high:101,low:99,close:100,volume:100}];
  const breakout={time:start+300,open:100,high:103,low:99.5,close:102.5,volume:200};
  const setup=detectOpeningRange([...baseline,breakout],555,103);
  assert.equal(setup.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(setup.side,'LONG');
  const confirmation=confirmStrategyTriggerCandle([...baseline,breakout],'LONG',101,breakout.time);
  assert.equal(confirmation.ok,true);
  assert.equal(confirmation.candleTime,breakout.time);
  assert.equal('pressure' in confirmation,false);
  assert.equal('relativeVolume' in confirmation,false);
});

test('legacy confirmation export no longer applies pressure or volume filters',()=>{
  const rows=candleRows('LONG');
  rows[20]={...rows[20],open:100,high:104,low:99,close:100.5,volume:0};
  assert.equal(confirmStrategyTriggerCandle(rows,'LONG',101,rows[20].time).ok,true);
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

test('bullish and bearish flag detectors use price structure only, regardless of volume',()=>{
  const bullish=[];
  for(let i=0;i<17;i++){const close=100+i;bullish.push({time:1800000000+i*300,open:close-.2,high:close+.2,low:close-.4,close,volume:0});}
  for(let i=0;i<12;i++){const close=116-i*.05;bullish.push({time:1800005100+i*300,open:close+.1,high:117,low:115,close,volume:0});}
  bullish.push({time:1800008700,open:117,high:120,low:116.8,close:119,volume:0});
  assert.equal(detectFlagPriceStructure(bullish)?.side,'LONG');
  const bearish=[];
  for(let i=0;i<17;i++){const close=120-i;bearish.push({time:1800000000+i*300,open:close+.2,high:close+.4,low:close-.2,close,volume:0});}
  for(let i=0;i<12;i++){const close=104+i*.05;bearish.push({time:1800005100+i*300,open:close-.1,high:105,low:103,close,volume:0});}
  bearish.push({time:1800008700,open:103,high:103.2,low:100,close:101,volume:0});
  assert.equal(detectFlagPriceStructure(bearish)?.side,'SHORT');
});

test('daily trend pullback rejects stale 15m candles even when 5m candles are present',()=>{
  const rows=Array.from({length:50},(_,i)=>({time:1800000000+i*300,open:100+i*.1,high:100.2+i*.1,low:99.9+i*.1,close:100.1+i*.1,volume:100}));
  const stale=Array.from({length:50},(_,i)=>({time:1700000000+i*900,open:100+i,high:101+i,low:99+i,close:100.5+i,volume:1000}));
  assert.equal(detectDailyTrendPullback(rows,stale,1800000000000),null);
});
test('daily trend pullback detector blocks missing or stale daily context', () => {
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


test('daily trend plus 5m pullback detector confirms bullish EMA alignment and resume after a pullback touch',()=>{
  const now=Date.parse('2026-11-23T10:05:00Z');
  const start=Math.floor(now/1000)-60*300;
  const rows=Array.from({length:60},(_,i)=>{const close=100+i*.2;return{time:start+i*300,open:close-.05,high:close+.1,low:close-.1,close,volume:100};});
  rows[58]={time:start+58*300,open:109.05,high:109.15,low:108.7,close:108.9,volume:120};
  rows[59]={time:start+59*300,open:109.1,high:109.7,low:109,close:109.6,volume:150};
  const daily=makeDailyCandles(now,'LONG');
  const result=detectDailyTrendPullback(rows,daily,now);
  assert.equal(result?.side,'LONG');
  assert.equal(result?.strategy,'DAILY_TREND_5M_PULLBACK');
  assert.equal(detectDailyTrendPullback(rows,[],now),null);
});


test('confirmed bearish underlying setup validates a PE contract and fixed Entry/SL/Target/RR', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=200-i,close=open-1.2;
    return {time:start+i*300,open,high:open+.1,low:close-.1,close,volume:i===49?2000:1000+i};
  });
  const optionCandles=[
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
  assertStaleOptionQuoteBlocks(underlyingCandles,'SHORT','EMA20_EMA50_TREND');
});

test('all ten strategies enforce the full LONG/CE and SHORT/PE contract-side matrix', () => {
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
test('contract expiry remains valid through the complete IST expiry day', () => {
  const now=Date.parse('2026-11-26T09:30:00+05:30');
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:0.05,
    expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'FY123'};
  const result=validateStrategyOptionContract({strategy:STRATEGIES[0],underlyingSide:'LONG',
    underlyingSymbol:'NSE:ABC-EQ',contract,now});
  assert.equal(result.ok,true);
});

test('strategy option gate rejects option tick symbol and completed candle timestamp mismatches', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const underlyingCandles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1.2;
    return {time:start+i*300,open,high:close+.1,low:open-.1,close,volume:1000+i};
  });
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:0.05,
    expiry:Date.parse('2026-11-26T00:00:00Z')/1000,strike:150,lotSize:1,fyToken:'ABC-CE-150'};
  const optionCandles=[{time:start+49*300,open:105,high:106,low:104,close:105.5,volume:520}];
  const base={underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:149.8,exchangeTime:now/1000,receivedAt:now},
    optionCandles,optionTick:{symbol:contract.symbol,price:106.05,exchangeTime:now/1000,receivedAt:now},
    contract,dailyCandles:[],fifteenMinuteCandles:[],researchEnabled:false,now};
  const wrongTick=evaluateNineStrategies({...base,optionTick:{...base.optionTick,symbol:'NSE:ABC26NOV150PE'}});
  assert.equal(wrongTick.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(wrongTick.reason,/tick symbol does not match/i);
  const unaligned=evaluateNineStrategies({...base,optionCandles:[{...optionCandles[0],time:optionCandles[0].time+60}]});
  assert.equal(unaligned.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(unaligned.reason,/session-aligned FYERS 5-minute candle/i);
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
  assert.equal(validateStrategyOptionContract({...args,contract:{...valid,expiry:now/1000-86400}}).ok,false);
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

test('end-to-end Top Gainer LONG setup passes underlying, CE contract, live premium breakout and fixed risk gates',()=>{
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
  const missingCandle=evaluateNineStrategies({...input,optionCandles:[]});
  assert.equal(missingCandle.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(missingCandle.reason,/latest completed candle is stale/);
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
    {time:start+600,open:105,high:106,low:104,close:105.5,volume:520}
  ];
  return {contract,optionCandles,optionTick:{symbol,price:106.05,exchangeTime:start/1+900,receivedAt:(start+900)*1000}};
}

test('end-to-end day-high breakout/retest reaches fixed-risk plan with one completed option candle',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, now=(start+1500)*1000;
  const underlyingCandles=[
    {time:start,open:100,high:101,low:99,close:100,volume:100},
    {time:start+300,open:100,high:102,low:99.5,close:101.8,volume:200},
    {time:start+600,open:101.5,high:103,low:101,close:102.5,volume:170},
    {time:start+900,open:101.2,high:102,low:100.9,close:101.7,volume:180}
  ];
  const option=makeOptionPipelineFields(start+300,'CE');
  for(const candle of underlyingCandles) candle.volume=0;
  option.optionCandles=option.optionCandles.map(c=>({...c,volume:0}));
  option.optionTick={...option.optionTick,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:101.7,exchangeTime:now/1000,receivedAt:now},...option,now,researchEnabled:false});
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'DAY_HIGH_LOW_BREAK_RETEST');
  assert.equal(result.underlyingSide,'LONG');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
  assertStaleOptionQuoteBlocks(underlyingCandles,'LONG','DAY_HIGH_LOW_BREAK_RETEST');
  const delayedOption=evaluateNineStrategies({underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:101.7,exchangeTime:now/1000,receivedAt:now},...option,optionTick:{...option.optionTick,exchangeTime:now/1000-5.001,receivedAt:now},now,researchEnabled:false});
  assert.equal(delayedOption.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(delayedOption.reason,/Fresh FYERS option premium tick/);
});

test('end-to-end opening-range first-candle breakout passes with one completed option candle',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, now=(start+900)*1000;
  const underlyingCandles=[
    {time:start,open:100,high:101,low:99,close:100,volume:100},
    {time:start+300,open:100,high:103,low:99.5,close:102.8,volume:200}
  ];
  const option=makeOptionPipelineFields(start-300,'CE');
  option.optionCandles=option.optionCandles.map(c=>({...c,time:start+300}));
  option.optionTick={...option.optionTick,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:102.8,exchangeTime:now/1000,receivedAt:now},...option,now,researchEnabled:false});
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(result.underlyingSide,'LONG');
  assert.ok(result.rr>=2);
  const stale=evaluateNineStrategies({underlyingCandles,underlyingTick:{symbol:'NSE:ABC-EQ',price:102.8,exchangeTime:now/1000,receivedAt:now},...option,optionTick:{...option.optionTick,receivedAt:now-11000},now,researchEnabled:false});
  assert.equal(stale.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.equal(stale.strategyLedger.find(row=>row.strategy==='OPENING_RANGE_BREAKOUT').status,'BLOCKED');
});


function assertStaleOptionQuoteBlocks(rows, side, strategy, extra={}) {
  const now=(rows.at(-1).time+360)*1000;
  const optionSide=side==='LONG'?'CE':'PE';
  const symbol='NSE:ABC26NOV150'+optionSide;
  const result=evaluateUnderlyingFixture(rows,side,{
    ...extra,
    optionTick:{symbol,price:106.05,exchangeTime:now/1000,receivedAt:now-11000}
  });
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE',JSON.stringify(result));
  assert.equal(result.strategyLedger.find(row=>row.strategy===strategy).status,'BLOCKED');
}

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
  for(let i=0;i<16;i++)rows.push({time:start+i*300,open:99.8,high:100.3,low:99.7,close:100,volume:100});
  rows.push({time:start+16*300,open:109,high:110.5,low:108.8,close:110,volume:200});
  for(let i=0;i<12;i++)rows.push({time:start+(17+i)*300,open:106.5,high:107,low:106,close:106.5,volume:100});
  rows.push({time:start+29*300,open:107.2,high:108.2,low:107.1,close:108.1,volume:200});
  const result=evaluateUnderlyingFixture(rows,'LONG');
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'BULLISH_CONTINUATION');
  assert.equal(result.underlyingSide,'LONG');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
  assertStaleOptionQuoteBlocks(rows,'LONG','BULLISH_CONTINUATION');
});

test('end-to-end bearish continuation validates the complete SHORT→PE→risk-plan pipeline',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, rows=[];
  for(let i=0;i<16;i++)rows.push({time:start+i*300,open:120.2,high:120.3,low:119.7,close:120,volume:100});
  rows.push({time:start+16*300,open:111,high:111.2,low:109.5,close:110,volume:200});
  for(let i=0;i<12;i++)rows.push({time:start+(17+i)*300,open:113.5,high:114,low:113,close:113.5,volume:100});
  rows.push({time:start+29*300,open:112.8,high:112.9,low:111.7,close:111.8,volume:200});
  const result=evaluateUnderlyingFixture(rows,'SHORT');
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'BEARISH_CONTINUATION');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.ok(result.rr>=2);
  assertStaleOptionQuoteBlocks(rows,'SHORT','BEARISH_CONTINUATION');
});

test('end-to-end flag price-breakout is independently selectable when continuation impulse threshold is not met',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000, rows=[];
  for(let i=0;i<16;i++)rows.push({time:start+i*300,open:99.8,high:100.3,low:99.7,close:100,volume:400});
  rows.push({time:start+16*300,open:109,high:110.5,low:108.8,close:110,volume:400});
  for(let i=0;i<12;i++){const close=108.5-i*.05;rows.push({time:start+(17+i)*300,open:close+.1,high:109.5,low:107.5,close,volume:0});}
  rows.push({time:start+29*300,open:111,high:113.5,low:110.8,close:113.2,volume:600});
  const result=evaluateUnderlyingFixture(rows,'LONG');
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'FLAG_BREAKOUT_PRICE_STRUCTURE');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
  assertStaleOptionQuoteBlocks(rows,'LONG','FLAG_BREAKOUT_PRICE_STRUCTURE');
});

test('end-to-end daily trend pullback requires fresh daily context and completes the SHORT/PE risk plan',()=>{
  const now=Date.parse('2026-11-23T08:00:00Z'),start=Math.floor(now/1000)-60*300;
  const rows=Array.from({length:60},(_,i)=>{const close=200-i*.2;return{time:start+i*300,open:close+.05,high:close+.1,low:close-.1,close,volume:100};});
  rows[58]={time:start+58*300,open:190,high:190.2,low:189.9,close:190.05,volume:120};
  rows[59]={time:start+59*300,open:189.8,high:189.85,low:189.2,close:189.3,volume:220};
  const lastTime=rows.at(-1).time,evaluationNow=(lastTime+360)*1000;
  const daily=makeDailyCandles(evaluationNow,'SHORT');
  const option=makeOptionPipelineFields(lastTime-600,'PE');
  option.optionTick={...option.optionTick,exchangeTime:evaluationNow/1000,receivedAt:evaluationNow};
  const base={underlyingCandles:rows,underlyingTick:{symbol:'NSE:ABC-EQ',price:189.3,exchangeTime:evaluationNow/1000,receivedAt:evaluationNow},...option,dailyCandles:daily,fifteenMinuteCandles:[],now:evaluationNow,researchEnabled:false};
  const result=evaluateNineStrategies(base);
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'DAILY_TREND_5M_PULLBACK');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.ok(result.rr>=2);
  const missingDaily=evaluateNineStrategies({...base,dailyCandles:[],fifteenMinuteCandles:[]});
  assert.notEqual(missingDaily.strategy,'DAILY_TREND_5M_PULLBACK');
  assert.equal(missingDaily.strategyLedger.find(row=>row.strategy==='DAILY_TREND_5M_PULLBACK').status,'BLOCKED');
  assertStaleOptionQuoteBlocks(rows,'SHORT','DAILY_TREND_5M_PULLBACK',{dailyCandles:daily});
});


test('end-to-end double-top neckline breakdown/retest validates SHORT→PE with original price cross',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000;
  const rows=Array.from({length:50},(_,i)=>({time:start+i*300,open:100,high:101,low:99,close:100,volume:100}));
  rows[5]={...rows[5],open:100,high:101,low:90,close:100};
  for(const i of [10,20])rows[i]={...rows[i],open:109,high:110,low:108,close:109};
  rows[22]={...rows[22],open:100,high:100.5,low:96.5,close:97,volume:200};
  for(let i=23;i<49;i++)rows[i]={...rows[i],open:98.2,high:98.5,low:97.5,close:98};
  rows[49]={...rows[49],open:98.8,high:99.1,low:97.5,close:97.8};
  const result=evaluateUnderlyingFixture(rows,'SHORT');
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST');
  assert.equal(result.underlyingSide,'SHORT');
  assert.equal(result.optionSide,'PE');
  assert.ok(result.rr>=2);
  assertStaleOptionQuoteBlocks(rows,'SHORT','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST');
});

test('end-to-end double-bottom neckline breakout/retest validates LONG→CE with original price cross',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000;
  const rows=Array.from({length:50},(_,i)=>({time:start+i*300,open:100,high:101,low:99,close:100,volume:100}));
  rows[5]={...rows[5],open:115,high:120,low:99,close:115};
  for(const i of [10,20])rows[i]={...rows[i],open:91,high:92,low:90,close:91};
  rows[15]={...rows[15],open:109,high:110,low:100,close:109};
  rows[22]={...rows[22],open:110,high:113,low:109.5,close:112.5,volume:200};
  for(let i=23;i<49;i++)rows[i]={...rows[i],open:112,high:113,low:111,close:112};
  rows[49]={...rows[49],open:109.9,high:110.5,low:109.8,close:110.3};
  const result=evaluateUnderlyingFixture(rows,'LONG');
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST');
  assert.equal(result.underlyingSide,'LONG');
  assert.equal(result.optionSide,'CE');
  assert.ok(result.rr>=2);
  assertStaleOptionQuoteBlocks(rows,'LONG','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST');
});

test('end-to-end nine-strategy negative matrix rejects a fresh, contiguous but pattern-neutral session',()=>{
  const start=Date.parse('2026-11-19T03:45:00Z')/1000; // 09:15 IST
  const underlyingCandles=Array.from({length:60},(_,i)=>({
    time:start+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  const now=(underlyingCandles.at(-1).time+360)*1000;
  const dailyStart=Date.parse('2026-09-20T00:00:00Z')/1000;
  const dailyCandles=Array.from({length:60},(_,i)=>({time:dailyStart+i*86400,open:100,high:101,low:99,close:100,volume:1000}));
  const result=evaluateNineStrategies({
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:100,exchangeTime:now/1000,receivedAt:now},
    dailyCandles,
    fifteenMinuteCandles:[],
    isTopGainer:true,
    researchEnabled:false,
    now
  });
  assert.equal(result.status,'NO_TRADE',JSON.stringify(result));
  assert.equal(result.strategy,undefined);
  assert.equal(result.strategyLedger.length,STRATEGIES.length);
  for(const strategy of STRATEGIES){
    const row=result.strategyLedger.find(item=>item.strategy===strategy);
    assert.ok(row, strategy+' must be present in the evaluator ledger');
    assert.equal(row.status,strategy==='DAILY_TREND_5M_PULLBACK'?'REJECTED':'REJECTED',strategy+' must reject a neutral completed-candle pattern: '+row.reason);
    assert.ok(row.reason, strategy+' must expose its pattern rejection reason');
  }
});

test('targeted strategy detector invalidation matrix rejects each missing pattern prerequisite',()=>{
  const start=Date.parse('2026-11-20T03:45:00Z')/1000;
  const flat=(count)=>Array.from({length:count},(_,i)=>({
    time:start+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  const rows50=flat(50);
  const rows48=flat(48);
  const rows30=flat(30);
  const rows5=flat(5);

  // EMA20/EMA50: neutral close cannot satisfy either directional stack.
  assert.equal(detectEmaTrend(rows50),null,'EMA alignment must reject a neutral tape');

  // Top Gainer: both membership and a close above the previous candle high are mandatory.
  assert.equal(detectTopGainerMomentum(rows5,false),null,'non-member cannot qualify as a Top Gainer');
  assert.equal(detectTopGainerMomentum(rows5,true),null,'Top Gainer membership without a breakout must reject');

  // daily trend pullback: absent verified daily context cannot produce a setup.
  assert.equal(detectDailyTrendPullback(rows50,[],Date.parse('2026-11-23T12:00:00Z')),null,
    '15m pullback must reject missing verified 15m history');

  // Day high/low retest: no prior level break means no reclaim/rejection setup.
  assert.equal(detectDayHighLowRetest(rows5),null,'day range without a break/retest must reject');

  // Double pattern: no comparable swing pair / neckline sequence.
  assert.equal(detectDoublePattern(rows48),null,'no double top/bottom structure must reject');

  // Continuation: flat impulse has no directional displacement or breakout.
  assert.equal(detectContinuation(rows30,'LONG'),null,'bullish continuation without impulse must reject');
  assert.equal(detectContinuation(rows30,'SHORT'),null,'bearish continuation without impulse must reject');

  // Flat price structure without an impulse and breakout remains ineligible.
  assert.equal(detectFlagPriceStructure(rows30),null,'flag without a price impulse and breakout must reject');

  // Opening range: first candle defines a range, but later closes remain inside it.
  assert.equal(detectOpeningRange(rows5),null,'opening range without a completed break must reject');
});


test('fixed premium Entry/SL/Target preserve exchange tick alignment and requested minimum RR across tick sizes', () => {
  for (const tickSize of [0.01, 0.05, 0.1, 0.25]) {
    for (const targetR of [2, 2.25, 2.5, 3]) {
      const plan = buildFixedPremiumPlan({
        breakoutLevel: 100.013,
        tickSize,
        livePremium: Math.ceil((100.013 + tickSize - 1e-9) / tickSize) * tickSize,
        swingLow: 99.013,
        targetR
      });
      assert.equal(plan.status, 'SETUP_CONFIRMED', JSON.stringify({tickSize,targetR,plan}));
      for (const price of [plan.entry, plan.stopLoss, plan.target]) {
        const ticks = price / tickSize;
        assert.ok(Math.abs(ticks - Math.round(ticks)) < 1e-7,
          'price must align to exchange tick size '+tickSize+': '+price);
      }
      assert.ok(plan.stopLoss < plan.entry);
      assert.ok(plan.target > plan.entry);
      assert.ok(plan.rr >= targetR - 1e-8);
      assert.ok(plan.rr >= 2);
    }
  }
});

test('fixed premium plan accepts exact 0.5R chase boundary and rejects any excess', () => {
  const base = buildFixedPremiumPlan({
    breakoutLevel:100, tickSize:0.05, livePremium:100.05 + 0.5 * 1.1,
    swingLow:99
  });
  assert.equal(base.status, 'SETUP_CONFIRMED');
  const chase = buildFixedPremiumPlan({
    breakoutLevel:100, tickSize:0.05, livePremium:100.05 + 0.5 * 1.1 + 0.001,
    swingLow:99
  });
  assert.equal(chase.status, 'NO_TRADE');
  assert.match(chase.reason,/more than 0.5R/);
});

test('fixed premium plan fails closed for invalid prices, tick size and target multiples', () => {
  const valid = {breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:99};
  for (const patch of [
    {breakoutLevel:0},{breakoutLevel:NaN},{tickSize:0},{tickSize:-0.05},
    {livePremium:0},{livePremium:NaN},{swingLow:0},{swingLow:NaN},
    {targetR:1.99},{targetR:3.01},{targetR:NaN}
  ]) {
    assert.equal(buildFixedPremiumPlan({...valid,...patch}).status,'NO_TRADE',
      'invalid input must fail closed: '+JSON.stringify(patch));
  }
});




test('daily-history warmup prefilter queues only a fresh completed 5m pullback/resume structure',()=>{
 const now=Date.parse('2026-11-26T08:00:30Z'),start=Date.parse('2026-11-26T03:45:00Z')/1000;
 const rows=Array.from({length:50},(_,i)=>({time:start+i*300,open:100,high:100.4,low:99.6,close:100,volume:0}));
 rows[48]={...rows[48],open:100,high:100.5,low:99.5,close:100};
 rows[49]={...rows[49],open:100.4,high:101.2,low:100.2,close:101};
 assert.equal(needsDailyTrendPullbackHistory(rows,now/1000),true);
 const neutral=rows.map(row=>({...row,open:100,high:100.4,low:99.6,close:100}));
 assert.equal(needsDailyTrendPullbackHistory(neutral,now/1000),false);
 assert.equal(needsDailyTrendPullbackHistory(rows,now/1000-30),false);
});
