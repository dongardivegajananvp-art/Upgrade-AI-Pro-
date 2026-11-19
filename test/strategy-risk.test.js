import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixedPremiumPlan, analyzeEarlyWatch, analyzeSetupResearch } from '../src/strategy-engine.js';

test('fixed premium plan rounds exact entry and structural stop to official tick size', () => {
  const plan=buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:98.9,targetR:2});
  assert.equal(plan.status,'SETUP_CONFIRMED');
  assert.equal(plan.entry,100.05);
  assert.equal(plan.stopLoss,98.85);
  assert.equal(plan.rr,2);
  assert.ok(plan.target>=plan.entry+2*(plan.entry-plan.stopLoss)-1e-8);
});

test('fixed premium plan rejects less than 2R and invalid target multiples', () => {
  assert.equal(buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:98.9,targetR:1.99}).status,'NO_TRADE');
  assert.equal(buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:98.9,targetR:3.01}).status,'NO_TRADE');
});

test('fixed premium plan blocks late entries beyond the 0.5R chase limit', () => {
  const plan=buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.70,swingLow:98.9,targetR:2});
  assert.equal(plan.status,'NO_TRADE');
  assert.match(plan.reason,/chase blocked/i);
});

test('fixed premium plan fails closed on missing tick size or invalid structural stop', () => {
  assert.equal(buildFixedPremiumPlan({breakoutLevel:100,tickSize:0,livePremium:100.05,swingLow:98.9,targetR:2}).status,'NO_TRADE');
  assert.equal(buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:100.1,targetR:2}).status,'NO_TRADE');
});

function risingCandles(count,start,step,interval) {
  return Array.from({length:count},(_,i)=>{
    const open=start+i*step,close=open+step;
    return {time:interval?Math.floor(Date.now()/1000)-((count-1-i)*interval):i+1,open,high:close+step,low:open-step,close,volume:1000+i};
  });
}
function flatCandles(count,baseTime,interval) {
  return Array.from({length:count},(_,i)=>({time:baseTime+i*interval,open:100,high:100.1,low:99.9,close:100,volume:1000}));
}

test('early breakout watch requires fresh tick and aligned daily plus 15m trends', () => {
  const now=Date.parse('2026-11-19T08:00:00Z');
  const start=Date.parse('2026-11-19T03:45:00Z')/1000;
  const five=Array.from({length:50},(_,i)=>{const open=100+i*.1,close=open+.1;return{time:start+i*300,open,high:close+.1,low:open-.1,close,volume:1000};});
  const daily=risingCandles(50,100,.5,86400);
  const fifteen=risingCandles(50,100,.2,900);
  const tick={price:five.at(-1).high+.1,exchangeTime:now/1000,receivedAt:now};
  const watch=analyzeEarlyWatch({candles:five,dailyCandles:daily,fifteenMinuteCandles:fifteen,tick,now});
  assert.equal(watch.status,'WATCH');
  assert.equal(watch.side,'LONG');
  assert.equal(analyzeEarlyWatch({candles:five,dailyCandles:daily,fifteenMinuteCandles:fifteen,tick:{...tick,receivedAt:now-20000},now}).status,'NO_WATCH');
});

test('research targets adapt to aligned trend versus range regime without reducing 2R floor', () => {
  const now=Date.parse('2026-11-19T08:00:00Z'), exchangeTime=now/1000;
  const tick={price:110,exchangeTime,receivedAt:now};
  const five=risingCandles(50,100,.1,300);
  const daily=risingCandles(50,100,.5,86400);
  const fifteen=risingCandles(50,100,.2,900);
  const setup={side:'LONG',strategy:'EMA20_EMA50_TREND',confirmedAt:five.at(-1).time,breakoutConfirmation:{pressure:'BUYING'}};
  const aligned=analyzeSetupResearch({candles:five,dailyCandles:daily,fifteenMinuteCandles:fifteen,tick,setup,now});
  assert.equal(aligned.status,'COMPLETE');
  assert.equal(aligned.targetR,2.5);
  assert.equal(aligned.marketRegime,'TRENDING_BULLISH');
  assert.equal(aligned.confidenceCalibration.status,'PENDING_REALIZED_OUTCOME_SAMPLE');
  const flatBase=exchangeTime-49*900;
  const flat=flatCandles(50,flatBase,900);
  const range=analyzeSetupResearch({candles:flat,dailyCandles:flat,fifteenMinuteCandles:flat,tick,setup:{...setup,confirmedAt:flat.at(-1).time},now});
  assert.equal(range.status,'COMPLETE');
  assert.equal(range.marketRegime,'RANGE/NEUTRAL');
  assert.equal(range.targetR,2);
  assert.ok(range.targetR>=2);
});
