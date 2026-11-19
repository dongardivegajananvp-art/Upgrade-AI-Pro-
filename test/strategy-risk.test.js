import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixedPremiumPlan } from '../src/strategy-engine.js';

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
