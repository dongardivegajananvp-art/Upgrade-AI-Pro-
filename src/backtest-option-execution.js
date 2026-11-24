const BAR=300, OFFSET=19800;
const STRATEGIES=new Set(['EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK','DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION','BEARISH_CONTINUATION','FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT']);
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const istDate=t=>new Date((Number(t)+OFFSET)*1000).toISOString().slice(0,10);
const up=(v,t)=>Number((Math.ceil(v/t-1e-9)*t).toFixed(8));
const down=(v,t)=>Number((Math.floor(v/t+1e-9)*t).toFixed(8));
const norm=v=>String(v||'').toUpperCase().replace(/^NSE:/,'').replace(/-(EQ|INDEX)$/,'');
const fail=reason=>({status:'DATA_UNAVAILABLE',actionable:false,ordersEnabled:false,reason,pnl:null,rMultiple:null});
function validCandle(c){return c&&c.completed===true&&c.source==='FYERS_EXPIRED_FO_5M'&&['time','open','high','low','close','volume'].every(k=>finite(c[k]))&&Number(c.time)>0&&Number(c.open)>0&&Number(c.close)>0&&Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low))&&Number(c.low)<=Math.min(Number(c.open),Number(c.close))&&Number(c.volume)>=0;}
function continuous(rows){return rows.every((r,i)=>i===0||(Number(r.time)-Number(rows[i-1].time)===BAR&&istDate(r.time)===istDate(rows[i-1].time)));}

/**
 * Conservative offline OHLC proxy for one completed underlying signal.
 * This is not a broker-fill simulation: bid/ask, spread, slippage, taxes,
 * fees, liquidity, queue position and market impact are unavailable.
 */
export function simulateExpiredOptionSignal({signal,optionDataset,contractSpec,topGainerMembership=[]}={}){
 if(!signal||!STRATEGIES.has(signal.strategy)||!['LONG','SHORT'].includes(signal.side)||!finite(signal.confirmedAt)||!finite(signal.evaluatedAt)||!finite(signal.underlyingClose)||Number(signal.evaluatedAt)!==Number(signal.confirmedAt)+BAR)return fail('A valid completed-candle nine-strategy signal with exact evaluation timestamp is required');
 if(signal.dataMode!=='FYERS_HISTORICAL_CANDLE_REPLAY')return fail('Only FYERS historical-candle strategy signals are accepted');
 if(signal.strategy==='TOP_GAINER_MOMENTUM_BREAKOUT'){
  const snap=Array.isArray(topGainerMembership)?topGainerMembership.find(x=>Number(x?.time)===Number(signal.confirmedAt)):null;
  if(!snap||!Array.isArray(snap.symbols)||!snap.symbols.map(x=>String(x).toUpperCase()).includes(String(signal.symbol).toUpperCase()))return fail('Timestamp-matched Top Gainer membership proof is missing; strategy is NOT_EVALUATED');
 }
 if(!optionDataset||optionDataset.source!=='FYERS_EXPIRED_FO_API'||optionDataset.timestampConvention!=='FYERS_EPOCH_BAR_START'||optionDataset.actionable!==false||optionDataset.ordersEnabled!==false)return fail('Verified FYERS expired-option candles with bar-start timestamps and non-actionable provenance are required');
 const side=signal.side==='LONG'?'CE':'PE';
 if(optionDataset.side!==side||norm(optionDataset.underlying)!==norm(signal.symbol)||!finite(optionDataset.selection?.selectionTime)||Number(optionDataset.selection.selectionTime)!==Number(signal.evaluatedAt)||!finite(optionDataset.selection?.underlyingPrice)||Math.abs(Number(optionDataset.selection.underlyingPrice)-Number(signal.underlyingClose))>1e-8||optionDataset.selection.method!=='NEAREST_LISTED_STRIKE_TO_COMPLETED_UNDERLYING_CLOSE')return fail('Option side, underlying, or historical ATM selection timestamp/price does not match the signal');
 if(!contractSpec||contractSpec.source!=='OFFICIAL_EXCHANGE_CONTRACT_MASTER'||!/^[a-f0-9]{64}$/.test(contractSpec.sha256||'')||contractSpec.symbol!==optionDataset.symbol||contractSpec.side!==side||norm(contractSpec.underlying)!==norm(signal.symbol)||String(contractSpec.expiry)!==String(optionDataset.expiry)||Number(contractSpec.strike)!==Number(optionDataset.strike)||!finite(contractSpec.tickSize)||Number(contractSpec.tickSize)<=0)return fail('Matching official historical contract-master evidence and tick size are required; no tick size is guessed');
 const rows=optionDataset.candles;
 if(!Array.isArray(rows)||rows.length<4||!rows.every(validCandle))return fail('At least four verified completed FYERS option candles are required');
 const sorted=rows.slice().sort((a,b)=>Number(a.time)-Number(b.time));
 if(sorted.some((r,i)=>i>0&&Number(r.time)<=Number(sorted[i-1].time)))return fail('Option candle timestamps must be unique and strictly increasing');
 if(!continuous(sorted))return fail('Option candles contain a session gap; execution replay is blocked');
 const day=istDate(signal.evaluatedAt);
 if(optionDataset.requested?.start!==day||optionDataset.requested?.end!==day||istDate(optionDataset.selection.selectionTime)!==day)return fail('Option dataset must cover only the same historical NSE trading session as the signal');
 const completed=sorted.filter(r=>Number(r.time)+BAR<=Number(signal.evaluatedAt));
 if(completed.length<3)return fail('Three completed option candles before the signal evaluation are required');
 const [prior,breakout,confirmation]=completed.slice(-3);
 if([prior,breakout,confirmation].some(r=>istDate(r.time)!==day)||Number(confirmation.time)+BAR!==Number(signal.evaluatedAt))return fail('Three-candle option breakout/retest pattern is not aligned to the underlying signal close');
 const tick=Number(contractSpec.tickSize);
 if(!(Number(breakout.close)>Number(prior.high)&&Number(breakout.close)>Number(breakout.open)&&Number(confirmation.low)<=Number(breakout.high)&&Number(confirmation.close)>Number(prior.high)&&Number(confirmation.close)>Number(confirmation.open)))return {status:'NO_TRADE',actionable:false,ordersEnabled:false,reason:'Historical option premium did not complete the required bullish breakout and retest structure',pnl:0,rMultiple:0};
 const entry=up(Number(confirmation.high)+tick,tick),stopLoss=down(Number(confirmation.low)-tick,tick),risk=Number((entry-stopLoss).toFixed(8));
 if(!(entry>stopLoss&&risk>=tick))return fail('Option candle structure does not produce positive tick-aligned premium risk');
 const target=up(entry+2*risk,tick);
 const future=sorted.filter(r=>Number(r.time)>=Number(signal.evaluatedAt));
 if(!future.length||Number(future[0].time)!==Number(signal.evaluatedAt))return fail('First post-signal option candle is missing; no fill is inferred across a gap');
 let fill=null,fillTime=null,exit=null,exitTime=null,exitReason=null;
 for(const c of future){
  const o=Number(c.open),h=Number(c.high),l=Number(c.low);
  if(fill===null){
   if(h<entry)continue;
   const candidate=o>=entry?o:entry;
   if(candidate>entry+0.5*risk+tick*1e-7)return {status:'NO_TRADE',actionable:false,ordersEnabled:false,reason:'Option opened beyond the 0.5R chase limit',entry,stopLoss,target,risk,pnl:0,rMultiple:0};
   fill=candidate;fillTime=Number(c.time);
   if(o<=stopLoss||l<=stopLoss){exit=o<stopLoss?o:stopLoss;exitTime=Number(c.time);exitReason='STOP';break;}
   if(h>=target){exit=target;exitTime=Number(c.time);exitReason='TARGET';break;}
   continue;
  }
  if(o<=stopLoss||l<=stopLoss){exit=o<stopLoss?o:stopLoss;exitTime=Number(c.time);exitReason='STOP';break;}
  if(h>=target){exit=target;exitTime=Number(c.time);exitReason='TARGET';break;}
 }
 if(fill===null)return {status:'NO_FILL',actionable:false,ordersEnabled:false,reason:'Option premium never reached the historical entry trigger',entry,stopLoss,target,risk,pnl:0,rMultiple:0};
 if(exit===null)return {status:'UNRESOLVED',actionable:false,ordersEnabled:false,reason:'No stop or target was reached before archived session ended',entry,stopLoss,target,risk,fill,fillTime,pnl:null,rMultiple:null};
 const pnl=Number((exit-fill).toFixed(8));
 return {status:'TRADE_CLOSED',actionable:false,ordersEnabled:false,performanceClass:'GROSS_CANDLE_PROXY_NOT_EXECUTABLE',symbol:signal.symbol,strategy:signal.strategy,underlyingSide:signal.side,optionSide:side,contract:optionDataset.symbol,expiry:optionDataset.expiry,strike:optionDataset.strike,entry:Number(fill.toFixed(8)),plannedEntry:entry,stopLoss,target,risk,exit:Number(exit.toFixed(8)),exitReason,fillTime,exitTime,pnl,rMultiple:Number((pnl/risk).toFixed(4)),assumptions:['Entry requires a later 5-minute candle high to cross the premium trigger.','A candle open above trigger is used as entry; entries beyond 0.5R are rejected.','If stop and target are both touched in one candle, stop is assumed first.','Gap-through-stop exits use the candle open.','Gross points only; spread, slippage, brokerage, taxes, liquidity, queue position and market impact are unavailable.']};
}
export function summarizeExpiredOptionReplay(results=[]){
 if(!Array.isArray(results))return {status:'DATA_UNAVAILABLE',tradePerformance:null};
 const closed=results.filter(r=>r?.status==='TRADE_CLOSED'&&Number.isFinite(Number(r.pnl))&&Number.isFinite(Number(r.rMultiple)));
 const unresolved=results.filter(r=>r?.status==='UNRESOLVED').length,unavailable=results.filter(r=>r?.status==='DATA_UNAVAILABLE').length;
 const noFill=results.filter(r=>['NO_FILL','NO_TRADE'].includes(r?.status)).length;
 const wins=closed.filter(r=>Number(r.pnl)>0),losses=closed.filter(r=>Number(r.pnl)<0);
 const gp=wins.reduce((s,r)=>s+Number(r.pnl),0),gl=Math.abs(losses.reduce((s,r)=>s+Number(r.pnl),0));
 return {status:unresolved||unavailable?'PARTIAL':results.length?'COMPLETE':'DATA_UNAVAILABLE',actionable:false,ordersEnabled:false,performanceClass:'GROSS_CANDLE_PROXY_NOT_EXECUTABLE',sampleCount:closed.length,winCount:wins.length,lossCount:losses.length,winRate:closed.length?Number((wins.length/closed.length*100).toFixed(2)):null,grossProfitFactor:gl>0?Number((gp/gl).toFixed(4)):null,expectancyR:closed.length?Number((closed.reduce((s,r)=>s+Number(r.rMultiple),0)/closed.length).toFixed(4)):null,grossNetPoints:Number(closed.reduce((s,r)=>s+Number(r.pnl),0).toFixed(8)),unresolvedCount:unresolved,noFillOrNoTradeCount:noFill,dataUnavailableCount:unavailable,limitations:['OHLC candle proxy outcomes, not actual executable fills or broker P&L.','No bid/ask spread, slippage, brokerage, taxes, liquidity, queue position or market impact is modeled.','Unresolved trades and unavailable datasets prevent a COMPLETE report.','Top Gainer results require timestamp-matched historical membership evidence.']};
}
