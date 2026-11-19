import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFeed, buildRiskPlan, canAdvanceSetup, tradingEnabled } from './safety.js';

const now = 1_800_000_000_000;
const tick = { price:100, exchangeTime:now/1000, receivedAt:now };

test('missing and stale ticks fail closed', () => {
  assert.equal(assessFeed(null,now).status,'MISSING');
  assert.equal(assessFeed({...tick,receivedAt:now-11000},now).status,'STALE');
});
test('fresh tick passes freshness gate', () => assert.equal(assessFeed(tick,now).status,'FRESH'));
test('risk plan requires at least 1:2', () => {
  assert.equal(buildRiskPlan({entry:100,stopLoss:99,target:102}).status,'RISK_PLAN_VALID');
  assert.equal(buildRiskPlan({entry:100,stopLoss:99,target:101.9}).status,'NO_TRADE');
});
test('setup cannot advance without both fresh ticks and verified evidence', () => {
  const plan=buildRiskPlan({entry:100,stopLoss:99,target:102});
  assert.equal(canAdvanceSetup({underlyingTick:tick,optionTick:null,contractVerified:true,candlesComplete:true,strategyConfirmed:true,riskPlan:plan}).status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.equal(canAdvanceSetup({underlyingTick:tick,optionTick:tick,contractVerified:true,candlesComplete:true,strategyConfirmed:true,riskPlan:plan}).status,'SETUP_ELIGIBLE_ORDER_DISABLED');
});
test('broker orders are disabled unconditionally', () => assert.equal(tradingEnabled(),false));
