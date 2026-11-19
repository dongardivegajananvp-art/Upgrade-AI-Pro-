// NSE-only nine-strategy engine ported from the previously approved strategy rules.
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

function analyzeEarlyWatch(){ return { status:'NO_WATCH' }; }

// Deterministic, explainable multi-timeframe research from verified FYERS OHLCV.
// This is not a claim of an external generative-AI model or paid AI service.
export function analyzeSetupResearch({candles=[],dailyCandles=[],fifteenMinuteCandles=[],tick,setup,marketRegime=null,now=Date.now()}={}) {
  const valid = rows => Array.isArray(rows) && rows.length && rows.every(c =>
    c && ['time','open','high','low','close','volume'].every(k => Number.isFinite(Number(c[k]))) &&
    Number(c.time)>0 && Number(c.open)>0 && Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low)) &&
    Number(c.low)<=Math.min(Number(c.open),Number(c.close)) && Number(c.volume)>=0);
  if (!valid(candles) || candles.length < 20) return {status:'UNAVAILABLE',reason:'At least 20 verified completed 5-minute candles are required'};
  if (!valid(dailyCandles) || dailyCandles.length < 50) return {status:'UNAVAILABLE',reason:'At least 50 verified daily candles are required for daily trend research'};
  if (!valid(fifteenMinuteCandles) || fifteenMinuteCandles.length < 50) return {status:'UNAVAILABLE',reason:'At least 50 verified 15-minute candles are required for multi-timeframe research'};
  const latest15m=Number(fifteenMinuteCandles.at(-1).time);
  if(!Number.isFinite(latest15m)||Number(tick?.exchangeTime)-latest15m < -3||Number(tick?.exchangeTime)-latest15m > 1800)
    return {status:'UNAVAILABLE',reason:'Latest completed FYERS 15-minute candle is stale or out of sequence'};
  if (!tick || !Number.isFinite(Number(tick.exchangeTime)) || !Number.isFinite(Number(tick.receivedAt)) ||
      now-Number(tick.receivedAt)<0 || now-Number(tick.receivedAt)>10000 ||
      now/1000-Number(tick.exchangeTime)<-3 || now/1000-Number(tick.exchangeTime)>10)
    return {status:'UNAVAILABLE',reason:'Fresh exchange-timestamped FYERS tick is required for research'};
  const trend = rows => {
    const closes=rows.map(c=>Number(c.close)),e20=ema(closes,20),e50=ema(closes,50),last=closes.at(-1);
    if(!Number.isFinite(e20)||!Number.isFinite(e50))return 'NEUTRAL';
    return last>e20&&e20>e50?'BULLISH':last<e20&&e20<e50?'BEARISH':'NEUTRAL';
  };
  const expected=setup?.side==='LONG'?'BULLISH':'BEARISH';
  const dailyTrend=trend(dailyCandles),fifteenTrend=trend(fifteenMinuteCandles),fiveTrend=trend(candles);
  const pressure=setup?.breakoutConfirmation?.pressure || (setup?.side==='LONG'?'BUYING':'SELLING');
  const volume=Number(candles.find(c=>Number(c.time)===Number(setup?.confirmedAt))?.volume);
  const aligned=t=>t===expected;
  const points={
    dailyTrend:aligned(dailyTrend)?20:dailyTrend==='NEUTRAL'?8:0,
    fifteenMinuteTrend:aligned(fifteenTrend)?20:fifteenTrend==='NEUTRAL'?8:0,
    fiveMinuteTrend:aligned(fiveTrend)?15:fiveTrend==='NEUTRAL'?6:0,
    directionalPressure:pressure===(setup?.side==='LONG'?'BUYING':'SELLING')?10:0,
    breakoutVolume:Number.isFinite(volume)&&volume>0?10:0,
    liveTickFresh:5,
    strategyEvidence:setup?.strategy?20:0
  };
  const qualityScore=Object.values(points).reduce((a,b)=>a+b,0);
  // In-app AI research chooses a risk multiple from verified multi-timeframe
  // alignment. Price levels remain deterministic and independently validated.
  const alignedFrames=[dailyTrend,fifteenTrend,fiveTrend].filter(value=>value===expected).length;
  const targetR=qualityScore>=85&&alignedFrames===3?2.5:qualityScore>=70&&alignedFrames>=2?2.25:2;
  const targetRationale=targetR===2.5?'A-grade research: all three timeframes align; 2.5R objective':
    targetR===2.25?'B-grade research: at least two timeframes align; 2.25R objective':
    'Conservative research objective: minimum 2R';
  const regime=dailyTrend===fifteenTrend&&dailyTrend!=='NEUTRAL'?'TRENDING_'+dailyTrend:(dailyTrend==='NEUTRAL'&&fifteenTrend==='NEUTRAL'?'RANGE/NEUTRAL':'MIXED');
  const evidence=['Daily trend: '+dailyTrend,'15-minute trend: '+fifteenTrend,'5-minute trend: '+fiveTrend,
    'Market regime: '+regime,'Breakout candle pressure: '+pressure,'Breakout candle volume: '+(Number.isFinite(volume)&&volume>0?'verified':'missing'),'FYERS tick: fresh'];
  return {status:'COMPLETE',qualityScore,grade:qualityScore>=85?'A':qualityScore>=70?'B':qualityScore>=55?'C':'D',
    direction:setup.side,timeframes:{daily:dailyTrend,fifteenMinute:fifteenTrend,fiveMinute:fiveTrend},
    points,evidence,marketRegime:marketRegime||regime,targetR,targetRationale,targetMethod:'AI_RESEARCH_ADAPTIVE_RISK_MULTIPLE',
    invalidation:'A completed 5-minute close back through the confirmed breakout level invalidates this research setup',
    source:'FYERS_VERIFIED_DAILY_15M_5M_OHLCV',asOfExchangeTime:Number(tick.exchangeTime)};
}


const INTERVAL_SECONDS = 300;
const MAX_ACTIVE_TRADES = 2;
const STRATEGIES = Object.freeze([
  'EMA20_EMA50_TREND',
  'TOP_GAINER_MOMENTUM_BREAKOUT',
  'DAILY_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST',
  'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',
  'BULLISH_CONTINUATION',
  'BEARISH_CONTINUATION',
  'FLAG_BREAKOUT_VOLUME',
  'OPENING_RANGE_BREAKOUT'
]);
// When multiple setups confirm on the same completed candle, prefer the more specific pattern over the broad EMA trend fallback.
const STRATEGY_TIE_PRIORITY = Object.freeze([
  'TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK','DAY_HIGH_LOW_BREAK_RETEST',
  'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION','BEARISH_CONTINUATION',
  'FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT','EMA20_EMA50_TREND'
]);

function finite(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function number(value) { return Number(value); }
function validOhlcv(c) {
  return c && ['time','open','high','low','close'].every(k => finite(c[k])) &&
    number(c.time) > 0 && number(c.open) > 0 && number(c.high) > 0 && number(c.low) > 0 && number(c.close) > 0 &&
    number(c.high) >= Math.max(number(c.open), number(c.close), number(c.low)) &&
    number(c.low) <= Math.min(number(c.open), number(c.close));
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
  if (!Array.isArray(rows) || rows.length < count) return false;
  const required = rows.slice(-count);
  return required.every((candle, index) => index === 0 ||
    isTradingCandleContiguous(number(required[index - 1].time), number(candle.time), sessionStartMinute, sessionCloseMinute));
}
function currentSessionRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const key = istDayKey(number(rows.at(-1).time));
  return rows.filter(candle => istDayKey(number(candle.time)) === key);
}
function completed(candles, tick, label, maxAgeSeconds = 600) {
  if (!Array.isArray(candles) || candles.some(c => !validOhlcv(c))) {
    return { error: label + ' candles are missing or malformed' };
  }
  const window = getCompletedCandleWindow(candles, tick.exchangeTime, maxAgeSeconds);
  if (!window.fresh) return { error: label + ' latest completed candle is stale' };
  if (window.completed.length < 2) return { error: label + ' requires at least two completed 5-minute candles' };
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
// This is a shared entry-quality condition inside the existing nine strategies,
// not a tenth strategy. For retest setups, validate the original level-crossing
// candle; for trend/pullback setups without a fresh level cross, validate trigger candle.
export function confirmBreakoutPressureVolume(rows, side, breakoutLevel = null, signalTime = null, requireLevelCross = false) {
  if (!Array.isArray(rows) || !['LONG','SHORT'].includes(side)) return { ok: false, reason: 'Verified completed OHLCV candles and direction are required' };
  const signalIndex = signalTime == null ? rows.length - 1 : rows.findIndex(c => number(c.time) === number(signalTime));
  if (signalIndex < 0) return { ok: false, reason: 'The strategy trigger candle is missing from verified history' };
  let breakoutIndex = signalIndex, levelCrossFound = false;
  if (finite(breakoutLevel)) {
    for (let i = signalIndex; i >= 1; i--) {
      const crossed = side === 'LONG'
        ? number(rows[i].close) > number(breakoutLevel) && number(rows[i-1].close) <= number(breakoutLevel)
        : number(rows[i].close) < number(breakoutLevel) && number(rows[i-1].close) >= number(breakoutLevel);
      if (crossed) { breakoutIndex = i; levelCrossFound = true; break; }
    }
  }
  if (requireLevelCross && !levelCrossFound) return { ok: false, reason: 'Original breakout/breakdown candle could not be verified; retest candle cannot substitute' };
  const candle = rows[breakoutIndex];
  if (!validOhlcv(candle)) return { ok: false, reason: 'Original breakout/breakdown candle OHLC is missing or invalid' };
  if (!finite(candle.volume) || number(candle.volume) <= 0) return { ok: false, reason: 'Original breakout/breakdown candle volume is missing or invalid' };
  const body = number(candle.close) - number(candle.open);
  const pressureOk = side === 'LONG' ? body > 0 : body < 0;
  if (!pressureOk) return { ok: false, reason: side === 'LONG' ? 'Buying pressure is absent on the breakout candle' : 'Selling pressure is absent on the breakdown candle' };
  return {
    ok: true,
    reason: side === 'LONG' ? 'Buying pressure and verified breakout-candle volume confirmed' : 'Selling pressure and verified breakdown-candle volume confirmed',
    candleTime: number(candle.time), breakoutVolume: number(candle.volume),
    pressure: side === 'LONG' ? 'BUYING' : 'SELLING'
  };
}

function candidate(strategy, side, level, candle, details={}) {
  if (!finite(level) || number(level)<=0) return null;
  return { strategy, side, breakoutLevel:number(level), confirmedAt:number(candle.time), confirmationClose:number(candle.close), ...details };
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
export function detectFlagVolume(rows) {
  const last=rows.at(-1), flag=rows.slice(-13,-1), impulse=rows.slice(-30,-13);
  const volumes=flag.map(c=>number(c.volume)).filter(Number.isFinite);
  const priorVol=rows.slice(-30,-13).map(c=>number(c.volume)).filter(Number.isFinite);
  if(volumes.length!==12||priorVol.length<10)return null;
  const avgFlag=volumes.reduce((a,b)=>a+b,0)/volumes.length;
  const avgPrior=priorVol.reduce((a,b)=>a+b,0)/priorVol.length;
  const high=Math.max(...flag.map(c=>number(c.high))),low=Math.min(...flag.map(c=>number(c.low)));
  const impulseUp=number(impulse.at(-1).close)>number(impulse[0].close);
  const impulseDown=number(impulse.at(-1).close)<number(impulse[0].close);
  if(avgFlag>=avgPrior*0.75)return null;
  if(impulseUp&&number(last.close)>high&&number(last.volume)>=avgFlag*1.5)return candidate('FLAG_BREAKOUT_VOLUME','LONG',high,last);
  if(impulseDown&&number(last.close)<low&&number(last.volume)>=avgFlag*1.5)return candidate('FLAG_BREAKOUT_VOLUME','SHORT',low,last);
  return null;
}
export function detectOpeningRange(rows, sessionStartMinute = 555, livePrice = null) {
  const key=istDayKey(number(rows.at(-1).time));
  const day=rows.filter(c=>istDayKey(number(c.time))===key);
  if(!day.length)return null;
  const sessionMinute=c=>{
    const t=new Date((number(c.time)+19800)*1000);
    return t.getUTCHours()*60+t.getUTCMinutes();
  };
  // The first completed 5-minute candle defines the opening high/low.
  // A fresh underlying exchange tick crossing that range is the early trigger;
  // a completed close outside the range remains a valid confirmation fallback.
  const first=day.find(c=>sessionMinute(c)===sessionStartMinute);
  const last=day.at(-1),prior=day.at(-2);
  if(first&&last){
    const firstHigh=number(first.high),firstLow=number(first.low);
    const hasLivePrice=livePrice!==null&&livePrice!==undefined&&Number.isFinite(Number(livePrice));
    const price=hasLivePrice?Number(livePrice):NaN;
    if(hasLivePrice&&number(last.close)<=firstHigh&&price>firstHigh)
      return candidate('OPENING_RANGE_BREAKOUT','LONG',firstHigh,last,{pattern:'FIRST_CANDLE_HIGH_LIVE_BREAKOUT'});
    if(hasLivePrice&&number(last.close)>=firstLow&&price<firstLow)
      return candidate('OPENING_RANGE_BREAKOUT','SHORT',firstLow,last,{pattern:'FIRST_CANDLE_LOW_LIVE_BREAKDOWN'});
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
  const risk=entry-stopLoss;
  if(!(risk>=step))return{status:'NO_TRADE',reason:'Single-candle confirmation swing low does not leave positive option-premium risk'};
  if(number(livePremium)+step*1e-7<entry)return{status:'NO_TRADE',reason:'Live option premium has not reached breakout level + one tick'};
  if(number(livePremium)>entry+0.5*risk+step*1e-7)return{status:'NO_TRADE',reason:'Option premium moved more than 0.5R beyond entry; chase blocked'};
  const target=Number((entry+risk*number(targetR)).toFixed(8));
  const plannedRr=(target-entry)/risk;
  if(!(Number.isFinite(plannedRr)&&plannedRr>=2-1e-9))return{status:'NO_TRADE',reason:'Fixed Entry/SL/Target do not preserve the required 1:2 reward/risk'};
  return{status:'SETUP_CONFIRMED',entry,stopLoss,target,rr:Number(plannedRr.toFixed(2)),risk,targetR:number(targetR)};
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
export function detectDailyTrendPullback(rows, dailyCandles=[]) {
  if (!Array.isArray(rows) || rows.length < 50 || !Array.isArray(dailyCandles)) return null;
  const dailyCloses=dailyCandles.filter(validOhlcv).map(c=>number(c.close));
  if(dailyCloses.length<50)return null;
  const d20=ema(dailyCloses,20),d50=ema(dailyCloses,50);
  const closes=rows.map(c=>number(c.close)),e20=ema(closes,20),e50=ema(closes,50);
  const last=rows.at(-1),p=rows.at(-2),touch=number(p.low)<=e20*1.003&&number(p.high)>=e20*0.997;
  if(d20>d50&&e20>e50&&touch&&number(last.close)>number(p.high))
    return candidate(STRATEGIES[2],'LONG',number(p.high),last);
  if(d20<d50&&e20<e50&&touch&&number(last.close)<number(p.low))
    return candidate(STRATEGIES[2],'SHORT',number(p.low),last);
  return null;
}

export function detectNineStrategySetup({ underlyingCandles, underlyingTick, dailyCandles=[], fifteenMinuteCandles=[], isTopGainer=false, now=Date.now(), sessionStartMinute=555, sessionCloseMinute=930, researchEnabled=false, marketRegime=null, maxCandleAgeSeconds=600 }) {
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason,strategyLedger:STRATEGIES.map(strategy=>({strategy,status:'BLOCKED',reason}))});
  const tickFresh=t=>Boolean(t&&finite(t.price)&&number(t.price)>0&&finite(t.exchangeTime)&&finite(t.receivedAt)&&now-number(t.receivedAt)>=0&&now-number(t.receivedAt)<=10000&&now/1000-number(t.exchangeTime)>=-3&&now/1000-number(t.exchangeTime)<=10);
  if(!tickFresh(underlyingTick))return fail('Fresh FYERS underlying/futures tick is required');
  const u=completed(underlyingCandles,underlyingTick,'Underlying',maxCandleAgeSeconds);
  if(u.error)return fail(u.error);
  const rows=u.rows,last=u.last;
  const candidates=[], evaluated=[], blocked=[], strategyLedger=[];
  const consider=(name,eligible,detect,blockedReason,rejectedReason='Latest completed candle does not meet this strategy pattern/trigger conditions')=>{
    if(!eligible){
      blocked.push(name);
      strategyLedger.push({strategy:name,status:'BLOCKED',reason:blockedReason});
      return;
    }
    evaluated.push(name);
    const result=detect();
    if(result){
      candidates.push(result);
      strategyLedger.push({strategy:name,status:'DETECTED',reason:'Strategy pattern and trigger conditions detected; common confirmation/research gates still apply',side:result.side,confirmedAt:result.confirmedAt});
    } else {
      strategyLedger.push({strategy:name,status:'REJECTED',reason:rejectedReason});
    }
  };
  // Each strategy validates only the candle history it actually consumes.
  // A gap in an older EMA50 window must not disable a valid two-candle momentum breakout.
  const w50=contiguousWindow(rows,50,sessionStartMinute,sessionCloseMinute);
  const w48=contiguousWindow(rows,48,sessionStartMinute,sessionCloseMinute);
  const w30=contiguousWindow(rows,30,sessionStartMinute,sessionCloseMinute);
  const w2=contiguousWindow(rows,2,sessionStartMinute,sessionCloseMinute);
  const dailyValid=Array.isArray(dailyCandles)&&dailyCandles.filter(validOhlcv).length>=50;
  consider('EMA20_EMA50_TREND',w50,()=>detectEmaTrend(rows),'Requires 50 contiguous completed 5-minute candles; EMA20/EMA50 window unavailable or discontinuous','Close is not above EMA20 > EMA50 for LONG or below EMA20 < EMA50 for SHORT');
  consider('TOP_GAINER_MOMENTUM_BREAKOUT',isTopGainer&&w2,()=>detectTopGainerMomentum(rows,isTopGainer),!isTopGainer?'Symbol is not in the verified current rolling Top Gainers set':'Requires two contiguous completed 5-minute candles','Latest completed 5-minute close did not break the previous completed candle high');
  consider('DAILY_TREND_5M_PULLBACK',w50&&dailyValid,()=>detectDailyTrendPullback(rows,dailyCandles),!w50?'Requires 50 contiguous completed 5-minute candles':'Requires 50 valid completed daily candles from FYERS','Daily and 5-minute EMA20/EMA50 alignment, EMA20 pullback touch, and next-candle resume close did not all confirm');
  const sessionRows=currentSessionRows(rows);
  const sessionContiguous=sessionRows.length>0&&contiguousWindow(sessionRows,sessionRows.length,sessionStartMinute,sessionCloseMinute);
  consider('DAY_HIGH_LOW_BREAK_RETEST',sessionRows.length>=4&&sessionContiguous,()=>detectDayHighLowRetest(rows),sessionRows.length<4?'Requires at least four current-session completed 5-minute candles':'Current-session candles are not contiguous','No current-session day-high/day-low break followed by a retest and close reclaim/rejection was confirmed');
  consider('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',w48,()=>detectDoublePattern(rows),'Requires 48 contiguous completed 5-minute candles','No two comparable swing highs/lows, neckline break, and subsequent neckline retest were all confirmed');
  consider('BULLISH_CONTINUATION',w30,()=>detectContinuation(rows,'LONG'),'Requires 30 contiguous completed 5-minute candles','No bullish impulse of at least 1.5x the consolidation range followed by a bullish continuation breakout');
  consider('BEARISH_CONTINUATION',w30,()=>detectContinuation(rows,'SHORT'),'Requires 30 contiguous completed 5-minute candles','No bearish impulse of at least 1.5x the consolidation range followed by a bearish continuation breakdown');
  consider('FLAG_BREAKOUT_VOLUME',w30,()=>detectFlagVolume(rows),'Requires 30 contiguous completed 5-minute candles','Flag volume did not contract below 75% of impulse volume or breakout volume did not reach 1.5x flag average');
  consider('OPENING_RANGE_BREAKOUT',sessionRows.length>=1&&sessionContiguous,()=>detectOpeningRange(rows,sessionStartMinute,number(underlyingTick.price)),sessionRows.length<1?'No completed current-session opening-range candle is available':'Current-session candles are not contiguous','Fresh live price or completed 5-minute close did not break and retest the first-candle/15-minute opening range');
  // Apply one identical pressure+volume gate to every strategy signal.
  const rejectedForConfirmation = [];
  const confirmedCandidates = candidates.filter(item => {
    const requireOriginalCross = ['DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST'].includes(item.strategy);
    const confirmation = confirmBreakoutPressureVolume(rows, item.side, item.breakoutLevel, item.confirmedAt, requireOriginalCross);
    if (!confirmation.ok) {
      rejectedForConfirmation.push({ strategy: item.strategy, reason: confirmation.reason, metrics: confirmation });
      const row=strategyLedger.find(entry=>entry.strategy===item.strategy);
      if(row){row.status='REJECTED';row.reason=confirmation.reason;}
      return false;
    }
    item.breakoutConfirmation = confirmation;
    return true;
  });
  candidates.splice(0, candidates.length, ...confirmedCandidates);
  if(!candidates.length){
    if(rejectedForConfirmation.length)return {status:'NO_TRADE',reason:'Breakout rejected: directional candle pressure and verified breakout-candle volume are mandatory',rejectedStrategies:rejectedForConfirmation,evaluatedStrategies:evaluated,blockedStrategies:blocked,strategyLedger};
    if(!evaluated.length)return {...fail('No strategy had its required fresh, contiguous candle window; blocked: '+blocked.join(', ')),strategyLedger};
    if(researchEnabled){
      const watch=analyzeEarlyWatch({candles:rows,dailyCandles,tick:underlyingTick,now});
      if(watch.status==='WATCH')return{status:'EARLY_WATCH',...watch,underlyingPrice:number(underlyingTick.price),evaluatedStrategies:evaluated,blockedStrategies:blocked};
    }
    return{status:'NO_TRADE',reason:'No eligible strategy confirmed a completed-candle setup',evaluatedStrategies:evaluated,blockedStrategies:blocked,strategyLedger};
  }
  if(researchEnabled){
    for(const item of candidates)item.research=analyzeSetupResearch({candles:rows,dailyCandles,fifteenMinuteCandles,tick:underlyingTick,setup:item,marketRegime,now});
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
  return{status:'UNDERLYING_SETUP_CONFIRMED',...candidates[0],researchRanking,strategyLedger,underlyingPrice:number(underlyingTick.price),underlyingCandleTime:last.time};
}

export function evaluateNineStrategies({ underlyingCandles, underlyingTick, optionCandles, optionTick, contract, dailyCandles=[], fifteenMinuteCandles=[], isTopGainer=false, now=Date.now(), sessionStartMinute=555, sessionCloseMinute=930, researchEnabled=false, marketRegime=null, maxCandleAgeSeconds=600 }) {
  let setup=null;
  const blockDetected=(reason)=>({
    status:'DATA_UNAVAILABLE_NO_TRADE',reason,
    strategyLedger:(setup?.strategyLedger||[]).map(row=>row.status==='DETECTED'?{...row,status:'BLOCKED',reason:'Underlying strategy detected; '+reason}:row)
  });
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason});
  const tickFresh=t=>Boolean(t&&finite(t.price)&&number(t.price)>0&&finite(t.exchangeTime)&&finite(t.receivedAt)&&now-number(t.receivedAt)>=0&&now-number(t.receivedAt)<=10000&&now/1000-number(t.exchangeTime)>=-3&&now/1000-number(t.exchangeTime)<=10);
  setup=detectNineStrategySetup({underlyingCandles,underlyingTick,dailyCandles,fifteenMinuteCandles,isTopGainer,now,sessionStartMinute,sessionCloseMinute,researchEnabled,marketRegime,maxCandleAgeSeconds});
  if(setup.status!=='UNDERLYING_SETUP_CONFIRMED')return setup;
  if(!tickFresh(optionTick))return blockDetected('Fresh FYERS option premium tick is required');
  if(!contract||!['CE','PE'].includes(contract.side)||!finite(contract.tickSize)||number(contract.tickSize)<=0)return blockDetected('Verified active CE/PE contract and tick size are required');
  const o=completed(optionCandles,optionTick,'Option premium',maxCandleAgeSeconds);
  if(o.error)return blockDetected(o.error);
  if(!contiguousWindow(o.rows,3,sessionStartMinute,sessionCloseMinute))return blockDetected('Option premium needs 3 contiguous completed 5-minute candles: prior level, breakout candle, and one confirmation/retest candle');
  const chosen=setup;
  if(contract.side!==(chosen.side==='LONG'?'CE':'PE'))return blockDetected('Selected option side does not match the confirmed underlying direction');
  const premiumRows=o.rows,tickSize=number(contract.tickSize);
  const prior=premiumRows.at(-2),reference=premiumRows.at(-1);
  // The underlying strategy already confirmed on a completed 5-minute candle.
  // Do not wait for a second option candle confirmation: trigger on a fresh live
  // option premium crossing the latest completed option candle high + one tick.
  const premiumLevel=number(reference.high);
  const entry=Number((Math.ceil((premiumLevel+tickSize-1e-9)/tickSize)*tickSize).toFixed(8));
  if(number(optionTick.price)+tickSize*1e-7<entry)return{status:'WAITING_FOR_OPTION_BREAKOUT',reason:'Underlying setup is confirmed; waiting for live option premium to break the latest completed 5-minute candle high + one tick',strategy:chosen.strategy,optionBreakoutLevel:premiumLevel,strategyLedger:(setup.strategyLedger||[]).map(row=>row.status==='DETECTED'?{...row,status:'BLOCKED',reason:'Waiting for verified live option premium to cross the breakout level'}:row)};
  // Structural risk uses the last two completed option candles; the live quote is
  // the trigger. This removes the redundant extra 5-minute confirmation delay.
  const swingLow=Math.min(number(prior.low),number(reference.low));
  const plan=buildFixedPremiumPlan({breakoutLevel:premiumLevel,tickSize,livePremium:optionTick.price,swingLow,targetR:chosen.research?.targetR||2});
  if(plan.status!=='SETUP_CONFIRMED')return{...plan,strategy:chosen.strategy,strategyLedger:(setup.strategyLedger||[]).map(row=>row.status==='DETECTED'?{...row,status:'BLOCKED',reason:plan.reason}:row)};
  return{status:'SETUP_CONFIRMED',strategy:chosen.strategy,underlyingSide:chosen.side,optionSide:contract.side,breakoutLevel:chosen.breakoutLevel,optionBreakoutLevel:premiumLevel,entry:plan.entry,entryTriggerPrice:plan.entry,stopLoss:plan.stopLoss,target:plan.target,risk:plan.risk,reward:Number((plan.target-plan.entry).toFixed(8)),rr:plan.rr,confirmedAt:chosen.confirmedAt,optionCandleTime:reference.time,optionConfirmation:'EARLY_LIVE_OPTION_PREMIUM_BREAK',entryTiming:'EARLY_VERIFIED_LIVE_PREMIUM_BREAK',entryBasis:'LATEST_COMPLETED_OPTION_CANDLE_HIGH_PLUS_ONE_OFFICIAL_TICK',stopLossBasis:'LOWER_OF_LAST_TWO_COMPLETED_OPTION_CANDLE_LOWS_MINUS_ONE_TICK',targetBasis:'AI_RESEARCH_ADAPTIVE_RISK_MULTIPLE',targetR:plan.targetR,targetRationale:chosen.research?.targetRationale||'Minimum 2R research objective',contract:contract.symbol,research:chosen.research||null,researchRanking:chosen.researchRanking||[],strategyLedger:setup.strategyLedger||[]};
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
