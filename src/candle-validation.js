export function isValidOhlcvCandle(candle) {
  if (!candle || !['time','open','high','low','close'].every(key => Number.isFinite(Number(candle[key])))) return false;
  const time=Number(candle.time),open=Number(candle.open),high=Number(candle.high),low=Number(candle.low),close=Number(candle.close);
  return time>0&&open>0&&high>0&&low>0&&close>0&&high>=Math.max(open,close,low)&&low<=Math.min(open,close);
}

function istParts(epochSeconds) {
  const date=new Date((Number(epochSeconds)+19800)*1000);
  return {day:date.toISOString().slice(0,10),minute:date.getUTCHours()*60+date.getUTCMinutes()};
}

export function validateSessionCandleWindow(rows, count, intervalSeconds, sessionStartMinute=555, sessionCloseMinute=930) {
  if(!Array.isArray(rows)||rows.length<count||!Number.isFinite(Number(intervalSeconds))||Number(intervalSeconds)<=0)return false;
  const required=rows.slice(-count);
  if(!required.every(isValidOhlcvCandle))return false;
  return required.every((candle,index)=>{
    if(index===0)return true;
    const previous=required[index-1],current=candle;
    const delta=Number(current.time)-Number(previous.time);
    if(delta===Number(intervalSeconds))return true;
    const before=istParts(previous.time),after=istParts(current.time);
    const intervalMinutes=Number(intervalSeconds)/60;
    return before.minute===sessionCloseMinute-intervalMinutes&&after.minute===sessionStartMinute&&after.day>before.day;
  });
}

export function validateFreshDailyCandleWindow(rows, now=Date.now(), minCount=50, maxAgeSeconds=5*86400) {
  if(!Array.isArray(rows)||rows.length<minCount||!rows.every(isValidOhlcvCandle))return false;
  const latest=Number(rows.at(-1)?.time),age=Number(now)/1000-latest;
  return Number.isFinite(age)&&age>=0&&age<=Number(maxAgeSeconds);
}
