import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, detectNineStrategySetup, evaluateNineStrategies, buildFixedPremiumPlan, canAcceptStrategyTrade, confirmBreakoutPressureVolume, analyzeSetupResearch, detectOpeningRange } from './strategy-engine.js';

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


test('common confirmation accepts a bullish breakout candle with verified volume', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 1 }
  ];
  const result = confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[1].time);
  assert.equal(result.ok, true);
  assert.equal(result.pressure, 'BUYING');
  assert.equal(result.breakoutVolume, 1);
});
test('common confirmation accepts a bearish breakdown candle with verified volume', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 100.5, low: 97, close: 97.2, volume: 1 }
  ];
  const result = confirmBreakoutPressureVolume(rows, 'SHORT', 99, rows[1].time);
  assert.equal(result.ok, true);
  assert.equal(result.pressure, 'SELLING');
});
test('common confirmation rejects a wick-only breakout without directional pressure', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 100, volume: 200 }
  ];
  assert.equal(confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[1].time).ok, false);
});
test('common confirmation rejects missing or zero breakout-candle volume', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 0 }
  ];
  assert.equal(confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[1].time).ok, false);
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
    const open=100+i,close=open+.8;
    return {time:start+i*300,open,high:close+.4,low:open-.4,close,volume:1000+i,completed:true};
  });
  const optionCandles=Array.from({length:3},(_,i)=>({
    time:start+(47+i)*300,open:103+i,high:104+i,low:102+i,close:103.5+i,volume:500+i,completed:true
  }));
  const contract={symbol:'NSE:ABC26NOV150CE',underlying:'ABC',side:'CE',tickSize:.05};
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

test('non-retest strategies validate pressure on the trigger candle, not an older level cross', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 200 },
    { time: 1800000600, open: 103, high: 103.5, low: 102, close: 102.5, volume: 150 }
  ];
  const nonRetest = confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[2].time, false);
  assert.equal(nonRetest.ok, false);
  assert.match(nonRetest.reason, /Buying pressure is absent/);

  const retest = confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[2].time, true);
  assert.equal(retest.ok, true);
  assert.equal(retest.candleTime, rows[1].time);
});


test('top-gainer breakout can be evaluated with its own two-candle window without waiting for unrelated EMA/daily history', () => {
  const now=1800000601000;
  const underlyingCandles=[
    {time:1800000000,open:99.5,high:101,low:99,close:100,volume:100},
    {time:1800000300,open:100,high:103,low:99.8,close:102,volume:250}
  ];
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


test('opening-range setup waits for the actual completed breakout candle before pressure and volume confirmation', () => {
  const start=Date.parse('2026-11-20T03:45:00Z')/1000; // 09:15 IST
  const first={time:start,open:100,high:101,low:99,close:100,volume:100};
  const second={time:start+300,open:100,high:103,low:99.5,close:100.5,volume:250};
  // Even a live price above the opening range cannot borrow the prior candle's pressure/volume.
  assert.equal(detectOpeningRange([first,second],555,103),null);
  const breakout={...second,close:102.5};
  const setup=detectOpeningRange([first,breakout],555,103);
  assert.equal(setup.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(setup.side,'LONG');
  const confirmation=confirmBreakoutPressureVolume([first,breakout],'LONG',101,breakout.time);
  assert.equal(confirmation.ok,true);
  assert.equal(confirmation.pressure,'BUYING');
  assert.equal(confirmation.breakoutVolume,250);
});

test('breakout candle confirmation requires directional body and positive candle volume only on that candle', () => {
  const prior={time:1800000000,open:100,high:101,low:99,close:100,volume:500};
  const bullish={time:1800000300,open:100,high:103,low:99.5,close:102,volume:10};
  const bearish={time:1800000300,open:102,high:102.5,low:97,close:98,volume:10};
  assert.equal(confirmBreakoutPressureVolume([prior,bullish],'LONG',101,bullish.time).ok,true);
  assert.equal(confirmBreakoutPressureVolume([prior,bearish],'SHORT',99,bearish.time).ok,true);
  assert.equal(confirmBreakoutPressureVolume([prior,{...bullish,volume:0}],'LONG',101,bullish.time).ok,false);
  assert.equal(confirmBreakoutPressureVolume([prior,{...bullish,close:100}],'LONG',101,bullish.time).ok,false);
});
