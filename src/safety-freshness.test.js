import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFeed, buildRiskPlan, tradingEnabled } from './safety.js';

const baseNow = 1_800_000_000_000;
function tick(delayMs = 250, receiveAgeMs = 1000) {
  const receivedAt = baseNow - receiveAgeMs;
  return {
    price: 100,
    exchangeTime: (receivedAt - delayMs) / 1000,
    receivedAt
  };
}

test('freshness requires exchange-to-receipt delay at or below five seconds', () => {
  assert.equal(assessFeed(tick(5000), baseNow).status, 'FRESH');
  const delayed = assessFeed(tick(5001), baseNow);
  assert.equal(delayed.status, 'STALE');
  assert.match(delayed.reason, /receipt age, exchange age, or exchange-to-receipt delay/);
});

test('freshness requires receipt age at or below ten seconds', () => {
  assert.equal(assessFeed(tick(250, 10_000), baseNow).status, 'FRESH');
  assert.equal(assessFeed(tick(250, 10_001), baseNow).status, 'STALE');
});

test('risk plan uses Entry minus SL and Target minus Entry and rejects below 2R', () => {
  const valid = buildRiskPlan({ entry: 100, stopLoss: 95, target: 110, tickSize: 0.05 });
  assert.equal(valid.status, 'RISK_PLAN_VALID');
  assert.equal(valid.risk, 5);
  assert.equal(valid.reward, 10);
  assert.equal(valid.rr, 2);
  assert.equal(buildRiskPlan({ entry: 100, stopLoss: 95, target: 109.95 }).status, 'NO_TRADE');
});

test('broker trading remains disabled', () => {
  assert.equal(tradingEnabled(), false);
});
