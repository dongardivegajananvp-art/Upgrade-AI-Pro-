import { isValidOhlcvCandle, validateSessionCandleWindow } from './candle-validation.js';
import { buildRiskPlan } from './safety.js';
// NSE-only ten-strategy engine; the original nine approved rules remain unchanged.
// Research enrichment is deliberately unavailable until its separate data sources are implemented.
function getCompletedCandleWindow(candles, exchangeTime, maxAgeSeconds = 600, contiguousCount = 21) {
  const stamp = Number(exchangeTime);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    return { completed: [], lastClosed: null, ageSeconds: Infinity, fresh: false };
  }
  const currentBucket = Math.floor(stamp / 300) * 300;
  const rows = Array.isArray(candles) ? candles : [];
  const completed = rows.length && Number(rows[rows.length - 1]?.time) === currentBucket
    ? rows.slice(0, -1)
    : rows;
  const lastClosed = completed[completed.length - 1] || null;
  const candleTime = Number(lastClosed?.time);
  const ageSeconds = lastClosed && Number.isFinite(candleTime) ? stamp - (candleTime + 300) : Infinity;
  const fresh = Boolean(lastClosed && Number.isFinite(candleTime) && ageSeconds >= -3 && ageSeconds <= maxAgeSeconds);
  const count = Math.max(1, Math.floor(Number(contiguousCount) || 21));
  const recent = completed.slice(-count);
  const contiguous = recent.length === count && recent.every((candle, index) => index === 0 || Number(candle.time) - Number(recent[index - 1].time) === 300);
  return { completed, lastClosed, ageSeconds, fresh, contiguous };
}

export function analyzeEarlyWatch({candles=[],fifteenMinuteCandles=[],tick,now=Date.now()}={}) {
  const fresh=Boolean(tick&&Number.isFinite(Number(tick.price))&&Number(tick.price)>0&&Number.isFinite(Number(tick.exchangeTime))&&Number.isFinite(Number(tick.receivedAt))&&now-Number(tick.receivedAt)>=0&&now-Number(tick.receivedAt)<=10000&&now/1000-Number(tick.exchangeTime)>=-3);
  const validFive=Array.isArray(candles)&&candles.length>=50&&contiguousWindow(candles,50);
  const validFifteen=hasFreshCompletedFifteenMinuteHistory(fifteenMinuteCandles,now,50,1800);
  if(!fresh||!validFive||!validFifteen)return{status:'NO_WATCH',reason:'Fresh FYERS tick plus contiguous, current 15-minute and 5-minute candle windows are required'};
  const trend=rows=>{const closes=rows.map(row=>Number(row.close)),e20=ema(closes,20),e50=ema(closes,50),last=closes.at(-1);if(!Number.isFinite(e20)||!Number.isFinite(e50))return'NEUTRAL';return last>e20&&e20>e50?'BULLISH':last<e20&&e20<e50?'BEARISH':'NEUTRAL';};
  const fifteen=trend(fifteenMinuteCandles),five=trend(candles),last=candles.at(-1),price=Number(tick.price);
  if(fifteen==='BULLISH'&&five==='BULLISH'&&price>Number(last.high))return{status:'WATCH',side:'LONG',trigger:'LIVE_PRICE_ABOVE_LAST_COMPLETED_5M_HIGH',level:Number(last.high),price,reason:'15m trend and 5m structure aligned; completed-candle strategy confirmation and fresh option gates remain mandatory'};
  if(fifteen==='BEARISH'&&five==='BEARISH'&&price<Number(last.low))return{status:'WATCH',side:'SHORT',trigger:'LIVE_PRICE_BELOW_LAST_COMPLETED_5M_LOW',level:Number(last.low),price,reason:'15m trend and 5m structure aligned; completed-candle strategy confirmation and fresh option gates remain mandatory'};
  return{status:'NO_WATCH',reason:'No live breakout watch aligned with 15-minute and 5-minute trend'};
}

// Deterministic, explainable multi-timeframe research from verified FYERS OHLCV.
// This is not a claim of an external generative-AI model or paid AI service.
export function analyzeSetupResearch({candles=[],fifteenMinuteCandles=[],tick,setup,marketRegime=null,now=Date.now()}={}) {
  const valid=rows=>Array.isArray(rows)&&rows.length&&rows.every(c=>c&&['time','open','high','low','close'].every(k=>Number.isFinite(Number(c[k])))&&Number(c.time)>0&&Number(c.open)>0&&Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low))&&Number(c.low)<=Math.min(Number(c.open),Number(c.close)));
  if(!valid(candles)||candles.length<50)return{status:'UNAVAILABLE',reason:'At least 50 verified completed 5-minute candles are required'};
  if(!contiguousWindow(candles,50))return{status:'UNAVAILABLE',reason:'The latest 50 completed 5-minute candles must be contiguous across verified NSE sessions'};
  if(!valid(fifteenMinuteCandles)||!hasFreshCompletedFifteenMinuteHistory(fifteenMinuteCandles,now,50,1800))return{status:'UNAVAILABLE',reason:'At least 50 fresh, contiguous completed 15-minute candles are required'};
  if(!tick||!Number.isFinite(Number(tick.exchangeTime))||!Number.isFinite(Number(tick.receivedAt))||now-Number(tick.receivedAt)<0||now-Number(tick.receivedAt)>10000||now/1000-Number(tick.exchangeTime)<-3||Number(tick.receivedAt)-Number(tick.exchangeTime)*1000<0||Number(tick.receivedAt)-Number(tick.exchangeTime)*1000>5000)return{status:'UNAVAILABLE',reason:'Fresh low-latency exchange-timestamped FYERS tick is required for research'};
  const trend=rows=>{const closes=rows.map(c=>Number(c.close)),e20=ema(closes,20),e50=ema(closes,50),last=closes.at(-1);if(!Number.isFinite(e20)||!Number.isFinite(e50))return'NEUTRAL';return last>e20&&e20>e50?'BULLISH':last<e20&&e20<e50?'BEARISH':'NEUTRAL';};
  const expected=setup?.side==='LONG'?'BULLISH':'BEARISH',fifteenTrend=trend(fifteenMinuteCandles),fiveTrend=trend(candles),patternCandle=candles.find(c=>Number(c.time)===Number(setup?.confirmedAt));
  const derivedRegime=fifteenTrend===fiveTrend&&fifteenTrend!=='NEUTRAL'?'TRENDING_'+fifteenTrend:(fifteenTrend==='NEUTRAL'&&fiveTrend==='NEUTRAL'?'RANGE/NEUTRAL':'MIXED');
  const regime=String(marketRegime||derivedRegime).toUpperCase(),regimePenalty=regime.includes('RANGE')?12:regime.includes('MIXED')?8:0;
  const aligned=t=>t===expected;
  const points={fifteenMinuteTrend:aligned(fifteenTrend)?35:fifteenTrend==='NEUTRAL'?12:0,fiveMinuteTrend:aligned(fiveTrend)?25:fiveTrend==='NEUTRAL'?8:0,strategyStructure:patternCandle&&validOhlcv(patternCandle)?20:0,liveTickFresh:5,strategyEvidence:setup?.strategy?15:0};
  const rawQualityScore=Object.values(points).reduce((a,b)=>a+b,0),qualityScore=Math.max(0,rawQualityScore-regimePenalty);
  const alignedFrames=[fifteenTrend,fiveTrend].filter(value=>value===expected).length,directionalRegime=regime.startsWith('TRENDING_')&&regime.endsWith(expected);
  const targetR=directionalRegime&&qualityScore>=85&&alignedFrames===2?2.5:!regime.includes('RANGE')&&!regime.includes('MIXED')&&qualityScore>=70&&alignedFrames===2?2.25:2;
  const targetRationale=targetR===2.5?'A-grade research: 15-minute and 5-minute trends align; 2.5R objective':targetR===2.25?'B-grade research: 15-minute and 5-minute trends align; 2.25R objective':'Conservative research objective: minimum 2R';
  const evidence=['15-minute trend: '+fifteenTrend,'5-minute trend: '+fiveTrend,'Market regime: '+regime,'Completed-candle strategy structure: verified','FYERS tick: fresh'];
  return{status:'COMPLETE',qualityScore,rawQualityScore,regimePenalty,grade:qualityScore>=85?'A':qualityScore>=70?'B':qualityScore>=55?'C':'D',direction:setup.side,timeframes:{fifteenMinute:fifteenTrend,fiveMinute:fiveTrend},points,evidence,marketRegime:regime,targetR,targetRationale,targetMethod:'15M_5M_RESEARCH_ADAPTIVE_RISK_MULTIPLE',confidenceCalibration:{status:'PENDING_REALIZED_OUTCOME_SAMPLE',sampleCount:0,reason:'Do not label research quality as win probability until verified trade outcomes exist'},invalidation:'A completed 5-minute close back through the confirmed breakout level invalidates this research setup',source:'FYERS_VERIFIED_15M_5M_OHLCV',asOfExchangeTime:Number(tick.exchangeTime)};
}


const INTERVAL_SECONDS = 300;
const MAX_ACTIVE_TRADES = 2;
const STRATEGIES = Object.freeze([
  'EMA20_EMA50_TREND',
  'TOP_GAINER_MOMENTUM_BREAKOUT',
  'FIFTEEN_MIN_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST',
  'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',
  'BULLISH_CONTINUATION',
  'BEARISH_CONTINUATION',
  'FLAG_BREAKOUT_PRICE_STRUCTURE',
  'OPENING_RANGE_BREAKOUT',
  'DAY_LOW_REVERSAL_BREAKOUT'
]);
// When multiple setups confirm on the same completed candle, prefer the more specific pattern over the broad EMA trend fallback.
const STRATEGY_TIE_PRIORITY = Object.freeze([
  'TOP_GAINER_MOMENTUM_BREAKOUT','FIFTEEN_MIN_TREND_5M_PULLBACK','DAY_HIGH_LOW_BREAK_RETEST',
  'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION','BEARISH_CONTINUATION',
  'FLAG_BREAKOUT_PRICE_STRUCTURE','OPENING_RANGE_BREAKOUT','DAY_LOW_REVERSAL_BREAKOUT','EMA20_EMA50_TREND'
]);

function finite(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function number(value) { return Number(value); }
function validOhlcv(c) { return isValidOhlcvCandle(c); }
function hasFreshCompletedFifteenMinuteHistory(rows, now = Date.now(), requiredCount = 50, maxAgeSeconds = 1800) {
  if (!Array.isArray(rows) || rows.length < requiredCount || rows.some(row => !validOhlcv(row))) return false;
  const recent=rows.slice(-requiredCount);
  if (!contiguousFifteenMinuteWindow(recent,requiredCount)) return false;
  const latest=recent.at(-1);
  const age=Number(now)/1000-(Number(latest.time)+900);
  return Number.isFinite(age)&&age>=-3&&age<=maxAgeSeconds;
}
function ema(values, period) {
  if (values.length < period) return NaN;
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) result = values[i] * alpha + result * (1 - alpha);
  return result;
}
function istDayKey(seconds) {
  return new Date((seconds + 19800) * 1000).toISOString().slice(0,10);
}
function isTradingCandleContiguous(previousTime, currentTime, sessionStartMinute = 555, sessionCloseMinute = 930) {
  if (currentTime - previousTime === INTERVAL_SECONDS) return true;
  const localParts = value => {
    const date = new Date((Number(value) + 19800) * 1000);
    return { day: date.toISOString().slice(0, 10), minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
  };
  const previous = localParts(previousTime), current = localParts(currentTime);
  return previous.minute === sessionCloseMinute - 5 && current.minute === sessionStartMinute && current.day > previous.day;
}
function contiguousWindow(rows, count, sessionStartMinute = 555, sessionCloseMinute = 930) {
  return validateSessionCandleWindow(rows, count, INTERVAL_SECONDS, sessionStartMinute, sessionCloseMinute);
}
function contiguousFifteenMinuteWindow(rows, count) {
  return validateSessionCandleWindow(rows, count, 900, 555, 930);
}
function currentSessionRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const key = istDayKey(number(rows.at(-1).time));
  return rows.filter(candle => istDayKey(number(candle.time)) === key);
}
function completed(candles, tick, label, maxAgeSeconds = 600, historicalAsOf = null, minimumCount = 2) {
  if (!Array.isArray(candles) || candles.some(c => !validOhlcv(c))) {
    return { error: label + ' candles are missing or malformed' };
  }
  const hasHistoricalAnchor = historicalAsOf !== null && historicalAsOf !== undefined && Number.isFinite(Number(historicalAsOf));
  const exchangeTime = hasHistoricalAnchor ? Number(historicalAsOf) : tick?.exchangeTime;
  const window = getCompletedCandleWindow(candles, exchangeTime, maxAgeSeconds);
  if (!window.fresh) {
    const lastCandleTime = Number(window.lastClosed?.time);
    const exchangeStamp = Number(exchangeTime);
    const age = Number.isFinite(lastCandleTime) && Number.isFinite(exchangeStamp)
      ? exchangeStamp - (lastCandleTime + INTERVAL_SECONDS) : null;
    const diagnostic = {
      label,
      exchangeTime: Number.isFinite(exchangeStamp) ? new Date(exchangeStamp * 1000).toISOString() : null,
      lastCompletedCandleTime: Number.isFinite(lastCandleTime) ? new Date(lastCandleTime * 1000).toISOString() : null,
      ageSeconds: Number.isFinite(age) ? Math.round(age) : null,
      maxAgeSeconds,
      candleCount: window.completed.length,
      currentBucket: Number.isFinite(exchangeStamp) ? Math.floor(exchangeStamp / INTERVAL_SECONDS) * INTERVAL_SECONDS : null
    };
    return { error: label + ' latest completed candle is stale; diagnostics=' + JSON.stringify(diagnostic) };
  }
  const requiredCount = Math.max(1, Math.floor(Number(minimumCount) || 2));
  if (window.completed.length < requiredCount) return { error: label + ' requires at least ' + requiredCount + ' completed 5-minute candle(s)' };
  return { rows: window.completed, last: window.lastClosed };
}
function pivotHigh(rows, i, width=2) {
  const value=number(rows[i].high);
  for(let j=Math.max(0,i-width);j<=Math.min(rows.length-1,i+width);j++) if(j!==i&&number(rows[j].high)>=value)return false;
  return true;
}
function pivotLow(rows, i, width=2) {
  const value=number(rows[i].low);
  for(let j=Math.max(0,i-width);j<=Math.min(rows.length-1,i+width);j++) if(j!==i&&number(rows[j].low)<=value)return false;
  return true;
}
// This is a shared entry-quality condition across the strategy set. For retest setups, validate the original level-crossing
// candle; for trend/pullback setups without a fresh level cross, validate trigger candle.
export function confirmStrategyTriggerCandle(rows, side, breakoutLevel = null, signalTime = null, requireLevelCross = false) {
  if (!Array.isArray(rows) || !['LONG','SHORT'].includes(side)) return { ok:false, reason:'Verified completed 5-minute candles and strategy direction are required' };
  const signalIndex=signalTime==null?rows.length-1:rows.findIndex(c=>number(c.time)===number(signalTime));
  if(signalIndex<0)return{ok:false,reason:'The strategy trigger candle is missing from verified history'};
  let triggerIndex=signalIndex,levelCrossFound=false;
  // Retest patterns retain their original level-cross -> retest sequence.
  // No candle-body, buying/selling-pressure, or volume threshold is applied.
  if(requireLevelCross&&finite(breakoutLevel)){
    for(let i=signalIndex;i>=1;i--){
      const crossed=side==='LONG'
        ? number(rows[i].close)>number(breakoutLevel)&&number(rows[i-1].close)<=number(breakoutLevel)
        : number(rows[i].close)<number(breakoutLevel)&&number(rows[i-1].close)>=number(breakoutLevel);
      if(crossed){triggerIndex=i;levelCrossFound=true;break;}
    }
  }
  if(requireLevelCross&&!levelCrossFound)return{ok:false,reason:'Original completed-candle level break could not be verified; retest candle cannot substitute'};
  const candle=rows[triggerIndex];
  if(!validOhlcv(candle))return{ok:false,reason:'Strategy trigger candle OHLC is missing or invalid'};
  return{ok:true,reason:'Strategy trigger candle and required price-level sequence verified',
    candleTime:number(candle.time),breakoutLevel:finite(breakoutLevel)?number(breakoutLevel):null,
    retestSequenceVerified:Boolean(requireLevelCross)};
}

function candidate(strategy, side, level, candle, details={}) {
  if (!finite(level) || number(level)<=0) return null;
  return { strategy, side, breakoutLevel:number(level), confirmedAt:number(candle.time), confirmationClose:number(candle.close), ...details };
}

// Day-Low reversal: a completed 5-minute bullish rejection must hold the
// established session low, then the next completed candle must close above
// the rejection candle high. This is a long-only setup; it never buys a falling
// price merely because it is near the low.
export function detectDayLowReversal(rows) {
  if (!Array.isArray(rows) || rows.length < 4) return null;
  const key = istDayKey(number(rows.at(-1).time));
  const day = rows.filter(c => istDayKey(number(c.time)) === key);
  if (day.length < 4) return null;
  const anchor = day.slice(0, -2);
  if (anchor.length < 2) return null;
  // Establish support only from candles that precede the rejection candle.
  // Including the rejection candle here lets a fresh session low define its own
  // support and can incorrectly turn a falling knife into a reversal setup.
  const anchorLows = anchor.map(c => number(c.low));
  if (!anchorLows.every(Number.isFinite)) return null;
  const dayLow = Math.min(...anchorLows);
  const rejection = day.at(-2);
  const trigger = day.at(-1);
  if (![dayLow, number(rejection.open), number(rejection.high), number(rejection.low), number(rejection.close), number(trigger.open), number(trigger.high), number(trigger.low), number(trigger.close)].every(Number.isFinite) || dayLow <= 0) return null;
  const tolerance = dayLow * 0.0015;
  const body = Math.abs(number(rejection.close) - number(rejection.open));
  const lowerWick = Math.min(number(rejection.open), number(rejection.close)) - number(rejection.low);
  // A small support probe is allowed, but a material new low invalidates the
  // established-support reversal thesis.
  const touchedSupport = number(rejection.low) >= dayLow - tolerance && number(rejection.low) <= dayLow + tolerance;
  const heldSupport = number(rejection.close) > dayLow && number(trigger.low) >= dayLow;
  const bullishRejection = number(rejection.close) > number(rejection.open) && body > 0 && lowerWick >= body;
  const confirmedBreakout = number(trigger.close) > number(trigger.open) && number(trigger.close) > number(rejection.high);
  if (!touchedSupport || !heldSupport || !bullishRejection || !confirmedBreakout) return null;
  return candidate('DAY_LOW_REVERSAL_BREAKOUT', 'LONG', number(rejection.high), trigger, {
    dayLowLevel: dayLow,
    rejectionCandleTime: number(rejection.time),
    entryPattern: 'DAY_LOW_HOLD_BULLISH_REJECTION_HIGH_BREAK'
  });
}
export function detectDoublePattern(rows) {
  const start=Math.max(2,rows.length-45), end=rows.length-3;
  const highs=[],lows=[];
  for(let i=start;i<end;i++){
    if(pivotHigh(rows,i,2))highs.push(i);
    if(pivotLow(rows,i,2))lows.push(i);
  }
  const last=rows.at(-1), prior=rows.slice(-3,-1);
  for(let a=0;a<highs.length;a++)for(let b=a+1;b<highs.length;b++){
    const i=highs[a],j=highs[b],h1=number(rows[i].high),h2=number(rows[j].high);
    if(j-i<4||Math.abs(h1-h2)/Math.max(h1,h2)>0.003)continue;
    const neck=Math.min(...rows.slice(i,j+1).map(x=>number(x.low)));
    const hadBreak=rows.slice(j+1,-1).some(x=>number(x.close)<neck);
    if(hadBreak&&number(last.high)>=neck*0.998&&number(last.close)<neck&&prior.some(x=>number(x.close)<neck))
      return candidate('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','SHORT',neck,last,{pattern:'DOUBLE_TOP'});
  }
  for(let a=0;a<lows.length;a++)for(let b=a+1;b<lows.length;b++){
    const i=lows[a],j=lows[b],l1=number(rows[i].low),l2=number(rows[j].low);
    if(j-i<4||Math.abs(l1-l2)/Math.max(l1,l2)>0.003)continue;
    const neck=Math.max(...rows.slice(i,j+1).map(x=>number(x.high)));
    const hadBreak=rows.slice(j+1,-1).some(x=>number(x.close)>neck);
    if(hadBreak&&number(last.low)<=neck*1.002&&number(last.close)>neck&&prior.some(x=>number(x.close)>neck))
      return candidate('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','LONG',neck,last,{pattern:'DOUBLE_BOTTOM'});
  }
  return null;
}
export function detectContinuation(rows, side) {
  const last=rows.at(-1), prior=rows.slice(-13,-1);
  const impulse=rows.slice(-30,-13);
  if(prior.length!==12||impulse.length<10)return null;
  const flagDrift=number(prior.at(-1).close)-number(prior[0].close);
  // Counter-trend pullback flags belong to the dedicated flag-breakout rule.
  if((side==='LONG'&&flagDrift<0)||(side==='SHORT'&&flagDrift>0))return null;
  const move=side==='LONG'
    ? number(impulse.at(-1).close)-number(impulse[0].close)
    : number(impulse[0].close)-number(impulse.at(-1).close);
  const range=Math.max(...prior.map(c=>number(c.high)))-Math.min(...prior.map(c=>number(c.low)));
  if(!(move>0&&range>0&&move>=range*1.5))return null;
  const ceiling=Math.max(...prior.map(c=>number(c.high)));
  const floor=Math.min(...prior.map(c=>number(c.low)));
  const breakout=side==='LONG'?number(last.close)>ceiling&&number(last.close)>number(last.open):number(last.close)<floor&&number(last.close)<number(last.open);
  if(!breakout)return null;
  const first=prior.slice(0,6),second=prior.slice(6);
  const firstHigh=Math.max(...first.map(c=>number(c.high))),secondHigh=Math.max(...second.map(c=>number(c.high)));
  const firstLow=Math.min(...first.map(c=>number(c.low))),secondLow=Math.min(...second.map(c=>number(c.low)));
  const ascendingTriangle=side==='LONG'&&Math.abs(ceiling-firstHigh)/ceiling<=0.003&&secondLow>firstLow;
  const descendingTriangle=side==='SHORT'&&Math.abs(floor-firstLow)/floor<=0.003&&secondHigh<firstHigh;
  const pattern=ascendingTriangle?'ASCENDING_TRIANGLE':descendingTriangle?'DESCENDING_TRIANGLE':range/move<0.45?'PENNANT':'FLAG';
  return candidate(side==='LONG'?'BULLISH_CONTINUATION':'BEARISH_CONTINUATION',side,side==='LONG'?ceiling:floor,last,{pattern});
}
export function detectFlagPriceStructure(rows) {
  const last=rows.at(-1),flag=rows.slice(-13,-1),impulse=rows.slice(-30,-13);
  if(flag.length!==12||impulse.length!==17||!last)return null;
  const high=Math.max(...flag.map(c=>number(c.high))),low=Math.min(...flag.map(c=>number(c.low)));
  const impulseHigh=Math.max(...impulse.map(c=>number(c.high))),impulseLow=Math.min(...impulse.map(c=>number(c.low)));
  const impulseRange=impulseHigh-impulseLow,flagRange=high-low;
  const impulseUp=number(impulse.at(-1).close)>number(impulse[0].close);
  const impulseDown=number(impulse.at(-1).close)<number(impulse[0].close);
  const flagDrift=number(flag.at(-1).close)-number(flag[0].close);
  // Dedicated flag setup requires a compact counter-trend pullback.
  if((impulseUp&&flagDrift>=0)||(impulseDown&&flagDrift<=0))return null;
  // Pure price-structure flag: require a real impulse and a compact flag range
  // (<=50% of the impulse range), then a completed close outside that range.
  // Volume contraction and breakout-volume filters are intentionally absent.
  if(!(impulseRange>0&&flagRange>0&&flagRange<=impulseRange*0.5))return null;
  if(impulseUp&&number(last.close)>high)return candidate('FLAG_BREAKOUT_PRICE_STRUCTURE','LONG',high,last,{pattern:'BULL_FLAG_PRICE_BREAKOUT'});
  if(impulseDown&&number(last.close)<low)return candidate('FLAG_BREAKOUT_PRICE_STRUCTURE','SHORT',low,last,{pattern:'BEAR_FLAG_PRICE_BREAKDOWN'});
  return null;
}

export function detectOpeningRange(rows, sessionStartMinute = 555) {
  const key=istDayKey(number(rows.at(-1).time));
  const day=rows.filter(c=>istDayKey(number(c.time))===key);
  if(!day.length)return null;
  const sessionMinute=c=>{
    const t=new Date((number(c.time)+19800)*1000);
    return t.getUTCHours()*60+t.getUTCMinutes();
  };
  // The first completed 5-minute candle defines the opening high/low.
  // A live tick alone is not a breakout candle: wait for the actual 5-minute
  // candle to close outside the range before it can be treated as a breakout.
  const first=day.find(c=>sessionMinute(c)===sessionStartMinute);
  const last=day.at(-1),prior=day.at(-2);
  if(first&&last){
    const firstHigh=number(first.high),firstLow=number(first.low);
    if(prior&&number(last.time)>number(first.time)){
      if(number(prior.close)<=firstHigh&&number(last.close)>firstHigh)
        return candidate('OPENING_RANGE_BREAKOUT','LONG',firstHigh,last,{pattern:'FIRST_CANDLE_HIGH_BREAKOUT'});
      if(number(prior.close)>=firstLow&&number(last.close)<firstLow)
        return candidate('OPENING_RANGE_BREAKOUT','SHORT',firstLow,last,{pattern:'FIRST_CANDLE_LOW_BREAKDOWN'});
    }
  }
  // Retain the existing 15-minute opening-range break/retest path as a
  // second confirmation route within the same ninth strategy.
  if(day.length<5)return null;
  const opening=day.filter(c=>{
    const t=new Date((number(c.time)+19800)*1000);
    const mins=t.getUTCHours()*60+t.getUTCMinutes();
    return mins>=sessionStartMinute&&mins<sessionStartMinute+15;
  });
  if(opening.length!==3)return null;
  const high=Math.max(...opening.map(c=>number(c.high))),low=Math.min(...opening.map(c=>number(c.low)));
  const later=day.filter(c=>number(c.time)>number(opening.at(-1).time));
  const rangeLast=rows.at(-1), rangePrior=later.slice(0,-1);
  if(!rangePrior.length)return null;
  const brokeHigh=rangePrior.some(c=>number(c.close)>high);
  const brokeLow=rangePrior.some(c=>number(c.close)<low);
  if(brokeHigh&&number(rangeLast.low)<=high*1.002&&number(rangeLast.close)>high)return candidate('OPENING_RANGE_BREAKOUT','LONG',high,rangeLast);
  if(brokeLow&&number(rangeLast.high)>=low*0.998&&number(rangeLast.close)<low)return candidate('OPENING_RANGE_BREAKOUT','SHORT',low,rangeLast);
  return null;
}
export function detectDayHighLowRetest(rows) {
  const key=istDayKey(number(rows.at(-1).time));
  const day=rows.filter(c=>istDayKey(number(c.time))===key);
  if(day.length<4)return null;
  const last=day.at(-1),prior=day.slice(0,-1);
  for(let i=1;i<prior.length;i++){
    const level=Math.max(...day.slice(0,i).map(c=>number(c.high)));
    if(number(prior[i].close)>level&&number(last.low)<=level*1.002&&number(last.close)>level)
      return candidate('DAY_HIGH_LOW_BREAK_RETEST','LONG',level,last);
  }
  for(let i=1;i<prior.length;i++){
    const level=Math.min(...day.slice(0,i).map(c=>number(c.low)));
    if(number(prior[i].close)<level&&number(last.high)>=level*0.998&&number(last.close)<level)
      return candidate('DAY_HIGH_LOW_BREAK_RETEST','SHORT',level,last);
  }
  return null;
}
export function buildFixedPremiumPlan({ breakoutLevel, tickSize, livePremium, swingLow, targetR = 2 }) {
  const values=[breakoutLevel,tickSize,livePremium,swingLow];
  if(!values.every(finite)||values.some(v=>number(v)<=0))return{status:'NO_TRADE',reason:'Breakout, tick size, live premium and confirmed-candle swing low must be positive'};
  if(!finite(targetR)||number(targetR)<2||number(targetR)>3)return{status:'NO_TRADE',reason:'AI-researched target multiple must remain between minimum 2R and maximum 3R'};
  const step=number(tickSize);
  const entry=Number((Math.ceil((number(breakoutLevel)+step-1e-9)/step)*step).toFixed(8));
  // One completed post-breakout confirmation/retest candle defines the swing low.
  // Place the stop one official option tick below that candle structure; ATR(14) is not required.
  const stopLoss=Number((Math.floor((number(swingLow)-step+1e-9)/step)*step).toFixed(8));
  if (!(Number.isFinite(stopLoss) && stopLoss > 0)) return { status: 'NO_TRADE', reason: 'Structural stop rounds to a non-positive option premium; a valid positive exchange stop is required' };
  const risk=entry-stopLoss;
  if(!(risk>=step))return{status:'NO_TRADE',reason:'Single-candle confirmation swing low does not leave positive option-premium risk'};
  if(number(livePremium)+step*1e-7<entry)return{status:'NO_TRADE',reason:'Live option premium has not reached breakout level + one tick'};
  if(number(livePremium)>entry+0.5*risk+step*1e-7)return{status:'NO_TRADE',reason:'Option premium moved more than 0.5R beyond entry; chase blocked'};
  // Option targets must also be valid exchange prices. Round the research
  // objective UP to the next official tick so tick rounding can never reduce
  // the requested reward/risk multiple.
  const rawTarget=entry+risk*number(targetR);
  const targetTicks=Math.ceil(rawTarget/step-1e-9);
  const target=Number((targetTicks*step).toFixed(8));
  const riskPlan=buildRiskPlan({entry,stopLoss,target,tickSize:step});
  if(riskPlan.status!=='RISK_PLAN_VALID')return{status:'NO_TRADE',reason:riskPlan.reason||'Canonical Entry/SL/Target risk validation failed'};
  return{status:'SETUP_CONFIRMED',entry,stopLoss,target,rr:riskPlan.rr,risk:riskPlan.risk,targetR:number(targetR)};
}

export function detectEmaTrend(rows) {
  if (!Array.isArray(rows) || rows.length < 50) return null;
  const last=rows.at(-1), closes=rows.map(c=>number(c.close));
  const e20=ema(closes,20),e50=ema(closes,50);
  if(e20>e50&&number(last.close)>e20)
    return candidate(STRATEGIES[0],'LONG',e20,last);
  if(e20<e50&&number(last.close)<e20)
    return candidate(STRATEGIES[0],'SHORT',e20,last);
  return null;
}
export function detectTopGainerMomentum(rows, isTopGainer=false) {
  if (!isTopGainer || !Array.isArray(rows) || rows.length < 2) return null;
  const last=rows.at(-1),prior=rows.at(-2);
  return number(last.close)>number(prior.high)
    ? candidate(STRATEGIES[1],'LONG',number(prior.high),last)
    : null;
}
export function detectFifteenMinuteTrendPullback(rows, fifteenMinuteCandles=[], now=Date.now()) {
  if(!Array.isArray(rows)||rows.length<50||!hasFreshCompletedFifteenMinuteHistory(fifteenMinuteCandles,now,50,1800))return null;
  const fifteenCloses=fifteenMinuteCandles.filter(validOhlcv).map(c=>number(c.close));
  if(fifteenCloses.length<50)return null;
  const m15_20=ema(fifteenCloses,20),m15_50=ema(fifteenCloses,50);
  const closes=rows.map(c=>number(c.close)),e20=ema(closes,20),e50=ema(closes,50);
  const last=rows.at(-1),p=rows.at(-2),touch=number(p.low)<=e20*1.003&&number(p.high)>=e20*0.997;
  if(m15_20>m15_50&&e20>e50&&touch&&number(last.close)>number(p.high))return candidate(STRATEGIES[2],'LONG',number(p.high),last);
  if(m15_20<m15_50&&e20<e50&&touch&&number(last.close)<number(p.low))return candidate(STRATEGIES[2],'SHORT',number(p.low),last);
  return null;
}

export function detectNineStrategySetup({ underlyingCandles, underlyingTick, dailyCandles=[], fifteenMinuteCandles=[], isTopGainer=false, now=Date.now(), sessionStartMinute=555, sessionCloseMinute=930, researchEnabled=false, marketRegime=null, maxCandleAgeSeconds=600, historicalAsOf=null }) {
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason,strategyLedger:STRATEGIES.map(strategy=>({strategy,status:'BLOCKED',reason}))});
  const tickFresh=t=>{if(!t||!finite(t.price)||number(t.price)<=0||!finite(t.exchangeTime)||!finite(t.receivedAt))return false;const receiptAge=now-number(t.receivedAt),exchangeAge=now/1000-number(t.exchangeTime),exchangeReceiptDelay=number(t.receivedAt)-number(t.exchangeTime)*1000;return receiptAge>=0&&receiptAge<=10000&&exchangeAge>=-3&&exchangeReceiptDelay>=0&&exchangeReceiptDelay<=5000;};
  const historicalRows=Array.isArray(underlyingCandles)?underlyingCandles:[];
  const lastHistoricalTime=Number(historicalRows.at(-1)?.time);
  const historicalMode=historicalAsOf!==null&&historicalAsOf!==undefined&&Number.isFinite(Number(historicalAsOf))&&Number(historicalAsOf)===lastHistoricalTime+300;
  if(!historicalMode&&!tickFresh(underlyingTick))return fail('Fresh FYERS underlying/futures tick is required');
  const u=completed(underlyingCandles,underlyingTick,'Underlying',maxCandleAgeSeconds,historicalMode?historicalAsOf:null);
  if(u.error)return fail(u.error);
  const rows=u.rows,last=u.last;
  const candidates=[], evaluated=[], blocked=[], strategyLedger=[];
  const triggerRejected=[];
  const consider=(name,eligible,detect,blockedReason,rejectedReason='Latest completed candle does not meet this strategy pattern/trigger conditions')=>{
    // One stock advances only its first fully confirmed strategy to the Entry
    // pipeline. Remaining strategies are deliberately skipped for this symbol;
    // the next symbol scan will evaluate them there.
    if(candidates.length){
      strategyLedger.push({strategy:name,status:'SKIPPED_AFTER_FIRST_PASS',reason:'A higher-priority strategy already passed; Entry verification has priority'});
      return;
    }
    if(!eligible){
      blocked.push(name);
      strategyLedger.push({strategy:name,status:'BLOCKED',reason:blockedReason});
      return;
    }
    evaluated.push(name);
    const result=detect();
    if(!result){
      strategyLedger.push({strategy:name,status:'REJECTED',reason:rejectedReason});
      return;
    }
    const requireOriginalCross=['DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST'].includes(result.strategy);
    const confirmation=confirmStrategyTriggerCandle(rows,result.side,result.breakoutLevel,result.confirmedAt,requireOriginalCross);
    if(!confirmation.ok){
      triggerRejected.push({strategy:result.strategy,reason:confirmation.reason});
      strategyLedger.push({strategy:name,status:'REJECTED',reason:confirmation.reason});
      return;
    }
    result.triggerConfirmation=confirmation;
    candidates.push(result);
    strategyLedger.push({strategy:name,status:'DETECTED',reason:'First valid strategy passed its own completed-candle trigger; Entry verification starts immediately',side:result.side,confirmedAt:result.confirmedAt});
  };
  // Each strategy validates only the candle history it actually consumes.
  // A gap in an older EMA50 window must not disable a valid two-candle momentum breakout.
  const w50=contiguousWindow(rows,50,sessionStartMinute,sessionCloseMinute);
  const w48=contiguousWindow(rows,48,sessionStartMinute,sessionCloseMinute);
  const w30=contiguousWindow(rows,30,sessionStartMinute,sessionCloseMinute);
  const w2=contiguousWindow(rows,2,sessionStartMinute,sessionCloseMinute);
  const fifteenValid=hasFreshCompletedFifteenMinuteHistory(fifteenMinuteCandles,now,50,1800);
  // Execute in specificity order. Once one strategy passes its own trigger,
  // this symbol moves to option/Entry verification without waiting for the rest.
  consider('TOP_GAINER_MOMENTUM_BREAKOUT',isTopGainer&&w2,()=>detectTopGainerMomentum(rows,isTopGainer),!isTopGainer?'Symbol is not in the verified current rolling Top Gainers set':'Requires two contiguous completed 5-minute candles (prior candle plus trigger candle)','Latest completed 5-minute close did not break the previous completed candle high');
  consider('FIFTEEN_MIN_TREND_5M_PULLBACK',w50&&fifteenValid,()=>detectFifteenMinuteTrendPullback(rows,fifteenMinuteCandles,now),!w50?'Requires 50 contiguous completed 5-minute candles':'Requires 50 fresh, contiguous completed FYERS 15-minute candles','15-minute and 5-minute EMA20/EMA50 alignment, 5-minute EMA20 pullback touch, and next-candle resume close did not all confirm');
  const sessionRows=currentSessionRows(rows);
  const sessionContiguous=sessionRows.length>0&&contiguousWindow(sessionRows,sessionRows.length,sessionStartMinute,sessionCloseMinute);
  consider('DAY_HIGH_LOW_BREAK_RETEST',sessionRows.length>=4&&sessionContiguous,()=>detectDayHighLowRetest(rows),sessionRows.length<4?'Requires at least four current-session completed 5-minute candles':'Current-session candles are not contiguous','No current-session day-high/day-low break followed by a retest and close reclaim/rejection was confirmed');
  consider('DAY_LOW_REVERSAL_BREAKOUT',sessionRows.length>=4&&sessionContiguous,()=>detectDayLowReversal(sessionRows),sessionRows.length<4?'Requires at least four current-session completed 5-minute candles':'Current-session candles are not contiguous','No session-low support hold, bullish rejection candle and next-candle high breakout were all confirmed');
  consider('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',w48,()=>detectDoublePattern(rows),'Requires 48 contiguous completed 5-minute candles','No two comparable swing highs/lows, neckline break, and subsequent neckline retest were all confirmed');
  consider('BULLISH_CONTINUATION',w30,()=>detectContinuation(rows,'LONG'),'Requires 30 contiguous completed 5-minute candles','No bullish impulse of at least 1.5x the consolidation range followed by a bullish continuation breakout');
  consider('BEARISH_CONTINUATION',w30,()=>detectContinuation(rows,'SHORT'),'Requires 30 contiguous completed 5-minute candles','No bearish impulse of at least 1.5x the consolidation range followed by a bearish continuation breakdown');
  consider('FLAG_BREAKOUT_PRICE_STRUCTURE',w30,()=>detectFlagPriceStructure(rows),'Requires 30 contiguous completed 5-minute candles','No flag impulse, consolidation range, and completed price breakout confirmed');
  consider('OPENING_RANGE_BREAKOUT',sessionRows.length>=1&&sessionContiguous,()=>detectOpeningRange(rows,sessionStartMinute),sessionRows.length<1?'No completed current-session opening-range candle is available':'Current-session candles are not contiguous','No completed 5-minute candle broke and retested the first-candle/15-minute opening range');
  consider('EMA20_EMA50_TREND',w50,()=>detectEmaTrend(rows),'Requires 50 contiguous completed 5-minute candles; EMA20/EMA50 window unavailable or discontinuous','Close is not above EMA20 > EMA50 for LONG or below EMA20 < EMA50 for SHORT');
  strategyLedger.sort((a,b)=>STRATEGIES.indexOf(a.strategy)-STRATEGIES.indexOf(b.strategy));
  if(!candidates.length){
    if(triggerRejected.length)return{status:'NO_TRADE',reason:'Strategy price-level confirmation could not be verified',rejectedStrategies:triggerRejected,evaluatedStrategies:evaluated,blockedStrategies:blocked,strategyLedger};
    if(!evaluated.length)return {...fail('No strategy had its required fresh, contiguous candle window; blocked: '+blocked.join(', ')),strategyLedger};
    if(researchEnabled){
      const watch=analyzeEarlyWatch({candles:rows,fifteenMinuteCandles,tick:underlyingTick,now});
      if(watch.status==='WATCH')return{status:'EARLY_WATCH',...watch,underlyingPrice:number(underlyingTick.price),evaluatedStrategies:evaluated,blockedStrategies:blocked};
    }
    return{status:'NO_TRADE',reason:'No eligible strategy confirmed a completed-candle setup',evaluatedStrategies:evaluated,blockedStrategies:blocked,strategyLedger};
  }
  if(researchEnabled){
    for(const item of candidates)item.research=analyzeSetupResearch({candles:rows,fifteenMinuteCandles,tick:underlyingTick,setup:item,marketRegime,now});
    const researchReady=candidates.filter(item=>item.research?.status==='COMPLETE'&&finite(item.research.qualityScore));
    if(!researchReady.length){
      const pending=candidates[0]?.research||null;
      for(const item of candidates){const row=strategyLedger.find(entry=>entry.strategy===item.strategy);if(row){row.status='BLOCKED';row.reason=pending?.reason||'Verified multi-timeframe research is incomplete';}}
      return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:pending?.reason||'Complete fresh multi-timeframe AI research is required before an NSE setup can advance',research:pending,rejectedStrategies:candidates.map(item=>item.strategy),strategyLedger};
    }
    candidates.splice(0,candidates.length,...researchReady);
    candidates.sort((a,b)=>Number(b.research.qualityScore)-Number(a.research.qualityScore)||a.confirmedAt-b.confirmedAt||STRATEGY_TIE_PRIORITY.indexOf(a.strategy)-STRATEGY_TIE_PRIORITY.indexOf(b.strategy));
  }else candidates.sort((a,b)=>a.confirmedAt-b.confirmedAt||STRATEGY_TIE_PRIORITY.indexOf(a.strategy)-STRATEGY_TIE_PRIORITY.indexOf(b.strategy));
  const researchRanking=researchEnabled?candidates.slice(0,3).map((item,index)=>({
    rank:index+1,strategy:item.strategy,side:item.side,qualityScore:item.research.qualityScore,
    grade:item.research.grade,targetR:item.research.targetR,targetRationale:item.research.targetRationale,
    evidence:item.research.evidence,timeframes:item.research.timeframes,
    invalidation:item.research.invalidation
  })):[];
  return{status:'UNDERLYING_SETUP_CONFIRMED',...candidates[0],researchRanking,strategyLedger,underlyingPrice:number(underlyingTick?.price??last.close),underlyingCandleTime:last.time, ...(historicalMode?{dataMode:'HISTORICAL_CANDLES_ONLY'}:{})};
}

export function validateStrategyOptionContract({strategy,underlyingSide,underlyingSymbol,contract,now=Date.now()}={}) {
  if(!STRATEGIES.includes(strategy))return {ok:false,reason:'A recognized one of nine strategies is required'};
  if(!['LONG','SHORT'].includes(underlyingSide))return {ok:false,reason:'Confirmed LONG/SHORT underlying direction is required'};
  if(!contract||!['CE','PE'].includes(contract.side)||!finite(contract.tickSize)||number(contract.tickSize)<=0)
    return {ok:false,reason:'Verified active CE/PE contract and tick size are required'};
  const expectedSide=underlyingSide==='LONG'?'CE':'PE';
  if(contract.side!==expectedSide)return {ok:false,reason:'Selected option side does not match the confirmed underlying direction'};
  const expectedUnderlying=String(underlyingSymbol||'').trim().toUpperCase().replace(/^NSE:/,'').replace(/-(EQ|FUT|INDEX)$/,'');
  if(!expectedUnderlying||String(contract.underlying||'').trim().toUpperCase()!==expectedUnderlying)
    return {ok:false,reason:'Official option contract underlying does not match the selected NSE underlying'};
  if(typeof contract.symbol!=='string'||!/^NSE:/.test(contract.symbol)||
     !finite(contract.expiry)||number(contract.expiry)<=number(now)/1000||
     !finite(contract.strike)||number(contract.strike)<=0||
     !finite(contract.lotSize)||number(contract.lotSize)<=0||
     typeof contract.fyToken!=='string'||!contract.fyToken.trim())
    return {ok:false,reason:'Official NSE contract identity, future expiry, strike, lot size and FY token are required'};
  return {ok:true,expectedSide,underlying:expectedUnderlying};
}

export function evaluateNineStrategies({ underlyingCandles, underlyingTick, optionCandles, optionTick, contract, dailyCandles=[], fifteenMinuteCandles=[], isTopGainer=false, now=Date.now(), sessionStartMinute=555, sessionCloseMinute=930, researchEnabled=false, marketRegime=null, maxCandleAgeSeconds=600 }) {
  let setup=null;
  const blockDetected=(reason)=>({
    status:'DATA_UNAVAILABLE_NO_TRADE',reason,
    strategyLedger:(setup?.strategyLedger||[]).map(row=>row.status==='DETECTED'?{...row,status:'BLOCKED',reason:'Underlying strategy detected; '+reason}:row)
  });
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason});
  const tickFresh=t=>Boolean(t&&finite(t.price)&&number(t.price)>0&&finite(t.exchangeTime)&&finite(t.receivedAt)&&now-number(t.receivedAt)>=0&&now-number(t.receivedAt)<=10000&&now/1000-number(t.exchangeTime)>=-3 );
  setup=detectNineStrategySetup({underlyingCandles,underlyingTick,dailyCandles,fifteenMinuteCandles,isTopGainer,now,sessionStartMinute,sessionCloseMinute,researchEnabled,marketRegime,maxCandleAgeSeconds});
  if(setup.status!=='UNDERLYING_SETUP_CONFIRMED')return setup;
  if(!tickFresh(optionTick))return blockDetected('Fresh FYERS option premium tick is required');
  const chosen=setup;
  const contractGate=validateStrategyOptionContract({strategy:chosen.strategy,underlyingSide:chosen.side,underlyingSymbol:underlyingTick?.symbol,contract,now});
  if(!contractGate.ok)return blockDetected(contractGate.reason);
  const o=completed(optionCandles,optionTick,'Option premium',maxCandleAgeSeconds,null,1);
  if(o.error)return blockDetected(o.error);
  if(!contiguousWindow(o.rows,1,sessionStartMinute,sessionCloseMinute))return blockDetected('Option premium needs one fresh completed 5-minute candle');
  const confirmation=o.rows.at(-1),tickSize=number(contract.tickSize);
  if(number(confirmation.close)<=number(confirmation.open))
    return blockDetected('The latest completed option 5-minute candle must close bullish');
  const premiumLevel=number(confirmation.high);
  const entry=Number((Math.ceil((premiumLevel+tickSize-1e-9)/tickSize)*tickSize).toFixed(8));
  if(number(optionTick.price)+tickSize*1e-7<entry)return{status:'WAITING_FOR_OPTION_BREAKOUT',reason:'One fresh completed bullish option 5-minute candle verified; waiting for live option premium to break its high + one official tick',strategy:chosen.strategy,optionBreakoutLevel:premiumLevel,entryTriggerPrice:entry,optionTickSize:tickSize,contract:contract.symbol,optionSide:contract.side,strategyLedger:(setup.strategyLedger||[]).map(row=>row.status==='DETECTED'?{...row,status:'BLOCKED',reason:'Option candle confirmed; waiting for live premium to cross its high'}:row)};
  const swingLow=number(confirmation.low);
  const plan=buildFixedPremiumPlan({breakoutLevel:premiumLevel,tickSize,livePremium:optionTick.price,swingLow,targetR:chosen.research?.targetR||2});
  if(plan.status!=='SETUP_CONFIRMED')return{...plan,strategy:chosen.strategy,optionBreakoutLevel:premiumLevel,entryTriggerPrice:entry,optionTickSize:tickSize,contract:contract.symbol,optionSide:contract.side,strategyLedger:(setup.strategyLedger||[]).map(row=>row.status==='DETECTED'?{...row,status:'BLOCKED',reason:plan.reason}:row)};
  return{status:'SETUP_CONFIRMED',strategy:chosen.strategy,underlyingSide:chosen.side,optionSide:contract.side,breakoutLevel:chosen.breakoutLevel,optionBreakoutLevel:premiumLevel,entry:plan.entry,entryTriggerPrice:plan.entry,stopLoss:plan.stopLoss,target:plan.target,risk:plan.risk,reward:Number((plan.target-plan.entry).toFixed(8)),rr:plan.rr,confirmedAt:chosen.confirmedAt,optionCandleTime:confirmation.time,optionConfirmation:'ONE_COMPLETED_BULLISH_5M_CANDLE_PLUS_LIVE_BREAKOUT',entryTiming:'LIVE_PREMIUM_BREAK_AFTER_ONE_COMPLETED_BULLISH_CANDLE',entryBasis:'COMPLETED_CANDLE_HIGH_PLUS_ONE_OFFICIAL_TICK',stopLossBasis:'COMPLETED_CANDLE_LOW_MINUS_ONE_OFFICIAL_TICK',targetBasis:'AI_RESEARCH_ADAPTIVE_RISK_MULTIPLE',targetR:plan.targetR,targetRationale:chosen.research?.targetRationale||'Minimum 2R research objective',contract:contract.symbol,research:chosen.research||null,researchRanking:chosen.researchRanking||[],strategyLedger:setup.strategyLedger||[]};
}
export function canAcceptStrategyTrade(activeTrades, candidateTrade, maxActive=MAX_ACTIVE_TRADES) {
  if(!Array.isArray(activeTrades)||!candidateTrade||!candidateTrade.underlying||!candidateTrade.contract)return{ok:false,reason:'Active trade state or candidate identity is invalid'};
  if(!Number.isInteger(maxActive)||maxActive<1||maxActive>MAX_ACTIVE_TRADES)return{ok:false,reason:'Maximum active trade limit cannot exceed two'};
  if(activeTrades.length>=maxActive)return{ok:false,reason:'Maximum of two simultaneous strategy trades reached'};
  const duplicate=activeTrades.some(t=>t&&((t.underlying&&t.underlying===candidateTrade.underlying)||(t.contract&&t.contract===candidateTrade.contract)));
  if(duplicate)return{ok:false,reason:'Duplicate underlying or option contract already has an active trade'};
  return{ok:true};
}
export { MAX_ACTIVE_TRADES, STRATEGIES };
