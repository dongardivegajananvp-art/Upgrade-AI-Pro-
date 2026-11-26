import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSetupResearch } from '../src/strategy-engine.js';

const epoch = value => Date.parse(value) / 1000;
const candle = (time, index = 0) => ({
  time, open:100 + index * 0.1, high:101 + index * 0.1,
  low:99 + index * 0.1, close:100.5 + index * 0.1, volume:1000 + index
});
function fixtures() {
  const now = Date.parse('2026-11-20T05:25:05.000Z');
  const fiveStart = epoch('2026-11-20T01:15:00Z');
  const fiveMinute = Array.from({length:50},(_,i)=>candle(fiveStart+i*300,i));
  const session = day => {
    const start = epoch(day+'T03:45:00Z');
    return Array.from({length:25},(_,i)=>candle(start+i*900,i));
  };
  const fifteenMinute = [
    ...session('2026-11-18'),
    ...session('2026-11-19'),
    ...Array.from({length:6},(_,i)=>candle(epoch('2026-11-20T03:45:00Z')+i*900,i))
  ];
  const dailyStart = epoch('2026-10-01T00:00:00Z');
  const daily = Array.from({length:50},(_,i)=>candle(dailyStart+i*86400,i));
  const tick = {
    price:102, exchangeTime:epoch('2026-11-20T05:25:00Z'), receivedAt:now
  };
  const setup = {
    side:'LONG', strategy:'TOP_GAINER_MOMENTUM_BREAKOUT',
    confirmedAt:fiveMinute.at(-1).time,
    breakoutConfirmation:{pressure:'BUYING'}
  };
  return {now,fiveMinute,fifteenMinute,daily,tick,setup};
}

test('multi-timeframe research accepts contiguous verified session windows', () => {
  const f=fixtures();
  const result=analyzeSetupResearch({
    candles:f.fiveMinute,fifteenMinuteCandles:f.fifteenMinute,
    tick:f.tick,setup:f.setup,now:f.now
  });
  assert.equal(result.status,'COMPLETE');
});

test('multi-timeframe research blocks a gap in the latest 50 five-minute candles', () => {
  const f=fixtures();
  f.fiveMinute[10].time += 300;
  const result=analyzeSetupResearch({
    candles:f.fiveMinute,dailyCandles:f.daily,fifteenMinuteCandles:f.fifteenMinute,
    tick:f.tick,setup:f.setup,now:f.now
  });
  assert.equal(result.status,'UNAVAILABLE');
  assert.match(result.reason,/50 completed 5-minute.*contiguous/i);
});

test('multi-timeframe research blocks a gap in the latest 50 fifteen-minute candles', () => {
  const f=fixtures();
  f.fifteenMinute.splice(30,1);
  const result=analyzeSetupResearch({
    candles:f.fiveMinute,dailyCandles:f.daily,fifteenMinuteCandles:f.fifteenMinute,
    tick:f.tick,setup:f.setup,now:f.now
  });
  assert.equal(result.status,'UNAVAILABLE');
  assert.match(result.reason,/50 fresh, contiguous completed 15-minute/i);
});
