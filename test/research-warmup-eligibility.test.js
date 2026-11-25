import test from 'node:test';
import assert from 'node:assert/strict';
import { isEligibleForResearchWarmup } from '../src/research-warmup-eligibility.js';

function candles(count, gapAt = -1) {
  const rows=[];
  let time=1795500000;
  for(let i=0;i<count;i++) {
    if(i===gapAt) time+=600;
    rows.push({time,open:100,high:102,low:99,close:101,volume:1000});
    time+=300;
  }
  return rows;
}

test('research warmup accepts 50 contiguous completed 5-minute candles',()=>{
  assert.equal(isEligibleForResearchWarmup(candles(50)),true);
});

test('research warmup rejects fewer than 50 completed 5-minute candles',()=>{
  assert.equal(isEligibleForResearchWarmup(candles(49)),false);
});

test('research warmup rejects a gap in the required 50-candle window',()=>{
  assert.equal(isEligibleForResearchWarmup(candles(50,25)),false);
});

test('research warmup rejects missing or malformed history',()=>{
  assert.equal(isEligibleForResearchWarmup([]),false);
  assert.equal(isEligibleForResearchWarmup(null),false);
  const malformed=candles(50);
  malformed[49].close=0;
  assert.equal(isEligibleForResearchWarmup(malformed),false);
});
