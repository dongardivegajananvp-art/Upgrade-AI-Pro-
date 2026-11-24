import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateExpiredOptionSignal, summarizeExpiredOptionReplay } from './backtest-option-execution.js';

const t0=Math.floor(Date.parse('2025-03-26T03:45:00Z')/1000);
const signal={
  symbol:'NSE:SBIN-EQ',strategy:'EMA20_EMA50_TREND',side:'LONG',
  confirmedAt:t0+600,evaluatedAt:t0+900,underlyingClose:800,
  dataMode:'FYERS_HISTORICAL_CANDLE_REPLAY'
};
const candle=(offset,open,high,low,close)=>({
  time:t0+offset,open,high,low,close,volume:1000,completed:true,source:'FYERS_EXPIRED_FO_5M'
});
function fixture({future=[
  candle(900,109,111.4,108,111),
  candle(1200,111,117,110.5,116)
]}={}) {
 const dataset={
  source:'FYERS_EXPIRED_FO_API',timestampConvention:'FYERS_EPOCH_BAR_START',integrityVerified:true,
  actionable:false,ordersEnabled:false,symbol:'NSE:SBIN25MAR800CE',
  underlying:'NSE:SBIN-EQ',expiry:'2025-03-27',strike:800,side:'CE',
  selection:{method:'NEAREST_LISTED_STRIKE_TO_COMPLETED_UNDERLYING_CLOSE',selectionTime:signal.evaluatedAt,underlyingPrice:signal.underlyingClose},
  requested:{start:'2025-03-26',end:'2025-03-26'},
  candles:[
   candle(0,100,105,99,104),
   candle(300,104,110,103,109),
   candle(600,108,110,107,109),
   ...future
  ]
 };
 const contractSpec={
  source:'OFFICIAL_EXCHANGE_CONTRACT_MASTER',masterRowVerified:true,sha256:'a'.repeat(64),tradeDate:'2025-03-26',sourceUrl:'https://www.nseindia.com/all-reports-derivatives',masterFile:'NSE_FO_contract_26032025.csv.gz',masterFileSha256:'a'.repeat(64),
  symbol:dataset.symbol,underlying:dataset.underlying,expiry:dataset.expiry,
  strike:dataset.strike,side:'CE',tickSize:0.05
 };
 return {dataset,contractSpec};
}

test('offline option replay uses future bar trigger and stop/target with exact tick rounding',()=>{
 const {dataset,contractSpec}=fixture();
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'TRADE_CLOSED');
 assert.equal(result.performanceClass,'GROSS_CANDLE_PROXY_NOT_EXECUTABLE');
 assert.equal(result.entry,110.05);
 assert.equal(result.stopLoss,106.95);
 assert.equal(result.target,116.25);
 assert.equal(result.exit,116.25);
 assert.equal(result.exitReason,'TARGET');
 assert.equal(result.rMultiple,2);
 assert.equal(result.actionable,false);
 assert.equal(result.ordersEnabled,false);
});

test('offline option replay assumes stop first when stop and target are both touched in one candle',()=>{
 const {dataset,contractSpec}=fixture({future:[candle(900,110.05,118,106.95,114)]});
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'TRADE_CLOSED');
 assert.equal(result.exitReason,'STOP');
 assert.equal(result.exit,106.95);
 assert.ok(result.rMultiple<0);
});

test('offline option replay blocks missing historical contract tick-size evidence',()=>{
 const {dataset,contractSpec}=fixture();
 delete contractSpec.tickSize;
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'DATA_UNAVAILABLE');
 assert.match(result.reason,/Same-session official NSE daily F&O contract-master/);
});

test('offline option replay blocks selection from a different signal timestamp or underlying close',()=>{
 const {dataset,contractSpec}=fixture();
 dataset.selection.selectionTime-=300;
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'DATA_UNAVAILABLE');
 assert.match(result.reason,/selection timestamp\/price/);
});

test('Top Gainer execution requires timestamp-matched membership snapshot',()=>{
 const {dataset,contractSpec}=fixture();
 const topSignal={...signal,strategy:'TOP_GAINER_MOMENTUM_BREAKOUT'};
 const result=simulateExpiredOptionSignal({signal:topSignal,optionDataset:dataset,contractSpec,topGainerMembership:[]});
 assert.equal(result.status,'DATA_UNAVAILABLE');
 assert.match(result.reason,/NOT_EVALUATED/);
});

test('offline option replay blocks unresolved candle gaps and missing post-signal trigger bars',()=>{
 const {dataset,contractSpec}=fixture();
 dataset.candles[4].time+=300;
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'DATA_UNAVAILABLE');
 assert.match(result.reason,/gap/);
});

test('performance summary excludes unresolved trades and remains PARTIAL',()=>{
 const result=summarizeExpiredOptionReplay([
  {status:'TRADE_CLOSED',pnl:6.2,rMultiple:2},
  {status:'TRADE_CLOSED',pnl:-3.1,rMultiple:-1},
  {status:'UNRESOLVED',pnl:null,rMultiple:null},
  {status:'DATA_UNAVAILABLE',pnl:null,rMultiple:null}
 ]);
 assert.equal(result.status,'PARTIAL');
 assert.equal(result.sampleCount,2);
 assert.equal(result.winRate,50);
 assert.equal(result.grossProfitFactor,2);
 assert.equal(result.expectancyR,0.5);
 assert.equal(result.unresolvedCount,1);
 assert.equal(result.dataUnavailableCount,1);
 assert.equal(result.performanceClass,'GROSS_CANDLE_PROXY_NOT_EXECUTABLE');
});


test('offline option replay marks below-trigger bars that cross the chase ceiling as unresolved',()=>{
 const {dataset,contractSpec}=fixture({future:[candle(900,109,115,108,114)]});
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'UNRESOLVED');
 assert.match(result.reason,/cannot prove an in-range entry/);
 assert.equal(result.pnl,null);
});

test('offline option replay marks entry and stop touched in one below-trigger bar as unresolved',()=>{
 const {dataset,contractSpec}=fixture({future:[candle(900,109,111,106.95,108)]});
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'UNRESOLVED');
 assert.match(result.reason,/event order is unknowable/);
 assert.equal(result.pnl,null);
});

test('offline option replay blocks a contract master from a different trade date',()=>{
 const {dataset,contractSpec}=fixture();
 contractSpec.tradeDate='2025-03-25';
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'DATA_UNAVAILABLE');
 assert.match(result.reason,/Same-session official NSE daily F&O contract-master/);
});

test('offline option replay blocks missing official NSE daily master provenance',()=>{
 const {dataset,contractSpec}=fixture();
 delete contractSpec.masterFileSha256;
 const result=simulateExpiredOptionSignal({signal,optionDataset:dataset,contractSpec});
 assert.equal(result.status,'DATA_UNAVAILABLE');
 assert.match(result.reason,/Same-session official NSE daily F&O contract-master/);
});
