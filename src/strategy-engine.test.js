import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, detectNineStrategySetup, buildFixedPremiumPlan, canAcceptStrategyTrade, confirmBreakoutPressureVolume, analyzeSetupResearch } from './strategy-engine.js';

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
  const make=(count,step)=>Array.from({length:count},(_,i)=>({time:1700000000+i*step,open:100+i,high:101+i,low:99+i,close:100.8+i,volume:100+i}));
  const result=analyzeSetupResearch({candles:make(60,300),dailyCandles:make(60,86400),fifteenMinuteCandles:make(12,900),tick:{exchangeTime:now/1000,receivedAt:now},setup:{side:'LONG',confirmedAt:1700017700},now});
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
