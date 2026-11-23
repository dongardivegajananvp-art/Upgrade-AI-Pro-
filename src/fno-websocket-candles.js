// FYERS WebSocket-only 5-minute OHLC observation builder.
// Bars are diagnostic, not strategy/actionable: tick subscriptions rotate and
// cumulative-volume deltas cannot prove complete per-candle exchange volume.
function istDayKey(epochSeconds) {
  return new Date((Number(epochSeconds) + 19800) * 1000).toISOString().slice(0,10);
}
function inNseRegularSession(epochSeconds) {
  const d=new Date((Number(epochSeconds)+19800)*1000);
  const minute=d.getUTCHours()*60+d.getUTCMinutes();
  return minute>=555&&minute<930;
}
export function createFnoWebsocketCandleBuilder({maxSymbols=300,maxCandlesPerSymbol=120}={}) {
  const states=new Map();
  function ingest(symbol,tick) {
    const exchangeTime=Number(tick?.exchangeTime),price=Number(tick?.price);
    if(!/^NSE:[A-Z0-9&._-]+-EQ$/.test(String(symbol||''))||!Number.isFinite(exchangeTime)||exchangeTime<=0||
       !Number.isFinite(price)||price<=0||!inNseRegularSession(exchangeTime)) return {accepted:false,reason:'INVALID_OR_OFF_SESSION_TICK'};
    const bucket=Math.floor(exchangeTime/300)*300,day=istDayKey(exchangeTime);
    let state=states.get(symbol);
    if(!state){state={current:null,completed:[],lastExchangeTime:0,lastCumulativeVolume:null,lastSeenAt:0};states.set(symbol,state);}
    if(exchangeTime<state.lastExchangeTime) return {accepted:false,reason:'OUT_OF_ORDER_TICK'};
    const cumulative=Number(tick.cumulativeVolume);
    if(state.current&&bucket<state.current.time) return {accepted:false,reason:'OUT_OF_ORDER_BUCKET'};
    if(!state.current||bucket>state.current.time){
      if(state.current){
        const gapSeconds=bucket-state.current.time-300;
        const contiguous=gapSeconds===0&&state.current.sessionDate===day;
        state.completed.push({...state.current,completed:true,contiguous,gapBeforeSeconds:Math.max(0,gapSeconds)});
        if(state.completed.length>maxCandlesPerSymbol)state.completed.splice(0,state.completed.length-maxCandlesPerSymbol);
      }
      state.current={time:bucket,sessionDate:day,open:price,high:price,low:price,close:price,volume:null,volumeVerified:false,source:'FYERS_WS_OBSERVED_TICKS',completed:false};
    }else{
      state.current.high=Math.max(state.current.high,price);
      state.current.low=Math.min(state.current.low,price);
      state.current.close=price;
    }
    // Keep cumulative-volume continuity only as a diagnostic; never publish it as
    // verified candle volume because an off-slice gap may span multiple buckets.
    state.lastCumulativeVolume=Number.isFinite(cumulative)&&cumulative>=0?cumulative:state.lastCumulativeVolume;
    state.lastExchangeTime=exchangeTime;state.lastSeenAt=Number(tick.receivedAt)||Date.now();
    while(states.size>maxSymbols){const oldest=[...states.entries()].sort((a,b)=>a[1].lastSeenAt-b[1].lastSeenAt)[0];if(!oldest)break;states.delete(oldest[0]);}
    return {accepted:true,bucket};
  }
  function snapshot(symbol) {
    const state=states.get(symbol);
    if(!state)return {symbol,status:'NO_OBSERVATIONS',completedCandles:[],liveCandle:null,contiguousCompletedCount:0,actionable:false};
    let contiguous=0;
    for(let i=state.completed.length-1;i>=0;i--){
      if(i===state.completed.length-1){contiguous=1;continue;}
      if(state.completed[i+1].time-state.completed[i].time===300&&state.completed[i+1].sessionDate===state.completed[i].sessionDate)contiguous++;else break;
    }
    return {symbol,status:state.completed.length?'OBSERVED':'BUILDING_FIRST_CANDLE',
      completedCandles:state.completed.map(row=>({...row})),liveCandle:state.current?{...state.current}:null,
      contiguousCompletedCount:contiguous,lastExchangeTime:state.lastExchangeTime,lastSeenAt:state.lastSeenAt,
      volumeVerified:false,actionable:false,reason:'WebSocket observations are not a complete historical window and per-candle volume is not verified'};
  }
  function remove(symbol){return states.delete(symbol);}
  return {ingest,snapshot,remove,size:()=>states.size};
}