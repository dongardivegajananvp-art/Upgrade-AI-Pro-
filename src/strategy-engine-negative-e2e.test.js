import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, evaluateNineStrategies } from './strategy-engine.js';

function neutralPipeline({ fifteen = true, isTopGainer = false } = {}) {
  const fiveStart=Date.parse('2026-11-23T05:05:00Z')/1000;
  const underlyingCandles=Array.from({length:60},(_,i)=>({time:fiveStart+i*300,open:100,high:101,low:99,close:100,volume:100}));
  const now=Date.parse('2026-11-23T10:06:00Z');
  const fifteenStart=Date.parse('2026-11-20T03:45:00Z')/1000;
  const fifteenMinuteCandles=fifteen?Array.from({length:50},(_,i)=>{
    const day=i<25?'2026-11-20':'2026-11-23',slot=i%25;
    return{time:Date.parse(day+'T03:45:00Z')/1000+slot*900,open:100,high:101,low:99,close:100,volume:1000};
  }):[];
  return {
    underlyingCandles,
    underlyingTick:{symbol:'NSE:ABC-EQ',price:100,exchangeTime:now/1000,receivedAt:now},
    dailyCandles:[],fifteenMinuteCandles,isTopGainer,researchEnabled:false,now
  };
}

function assertNoActionablePlan(result, strategy) {
  assert.notEqual(result.status, 'SETUP_CONFIRMED', strategy + ' must not reach an actionable plan');
  assert.equal(result.strategy, undefined, strategy + ' must not be selected');
  for (const field of ['entry', 'stopLoss', 'target', 'rr', 'contract']) {
    assert.equal(result[field], undefined, strategy + ' must not expose ' + field);
  }
}

test('full evaluator negative E2E matrix blocks strategy-specific invalidation conditions before option/risk planning', () => {
  const cases = [
    {
      strategy: 'EMA20_EMA50_TREND',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /EMA20/
    },
    {
      strategy: 'TOP_GAINER_MOMENTUM_BREAKOUT',
      input: neutralPipeline({ isTopGainer: true }),
      status: 'REJECTED',
      reason: /did not break/
    },
    {
      strategy: 'FIFTEEN_MIN_TREND_5M_PULLBACK',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /EMA20 pullback touch/
    },
    {
      strategy: 'DAY_HIGH_LOW_BREAK_RETEST',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /day-high.*break|day-high.*retest|day-high\/day-low/i
    },
    {
      strategy: 'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /swing highs\/lows/
    },
    {
      strategy: 'BULLISH_CONTINUATION',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /bullish impulse/
    },
    {
      strategy: 'BEARISH_CONTINUATION',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /bearish impulse/
    },
    {
      strategy: 'FLAG_BREAKOUT_PRICE_STRUCTURE',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /flag impulse, consolidation range, and completed price breakout/
    },
    {
      strategy: 'OPENING_RANGE_BREAKOUT',
      input: neutralPipeline(),
      status: 'REJECTED',
      reason: /opening range/
    }
  ];

  for (const scenario of cases) {
    const result = evaluateNineStrategies(scenario.input);
    assertNoActionablePlan(result, scenario.strategy);
    assert.equal(result.status, 'NO_TRADE', scenario.strategy + ': ' + JSON.stringify(result));
    assert.equal(result.strategyLedger.length, STRATEGIES.length);
    const row = result.strategyLedger.find(item => item.strategy === scenario.strategy);
    assert.ok(row, scenario.strategy + ' must be represented in the strategy ledger');
    assert.equal(row.status, scenario.status, scenario.strategy + ': ' + row.reason);
    assert.match(row.reason, scenario.reason, scenario.strategy + ' must explain the failed condition');
  }
});

test('full evaluator blocks 15m trend pullback when fresh 15m history is absent', () => {
  const input = neutralPipeline({ fifteen: false });
  const result = evaluateNineStrategies(input);
  assertNoActionablePlan(result, 'FIFTEEN_MIN_TREND_5M_PULLBACK');
  assert.equal(result.status, 'NO_TRADE');
  const row = result.strategyLedger.find(item => item.strategy === 'FIFTEEN_MIN_TREND_5M_PULLBACK');
  assert.equal(row.status, 'BLOCKED');
  assert.match(row.reason, /50 fresh, contiguous completed FYERS 15-minute candles/);
});

test('full evaluator blocks Top Gainer strategy when current verified membership is absent', () => {
  const input = neutralPipeline({ isTopGainer: false });
  const result = evaluateNineStrategies(input);
  assertNoActionablePlan(result, 'TOP_GAINER_MOMENTUM_BREAKOUT');
  assert.equal(result.status, 'NO_TRADE');
  const row = result.strategyLedger.find(item => item.strategy === 'TOP_GAINER_MOMENTUM_BREAKOUT');
  assert.equal(row.status, 'BLOCKED');
  assert.match(row.reason, /not in the verified current rolling Top Gainers set/);
});
