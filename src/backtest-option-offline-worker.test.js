import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {runOfflineOptionExecutionDataset} from './backtest-option-offline-worker.js';

const t0=Math.floor(Date.parse('2025-03-26T03:45:00Z')/1000);
const signal={symbol:'NSE:SBIN-EQ',strategy:'EMA20_EMA50_TREND',side:'LONG',confirmedAt:t0+600,evaluatedAt:t0+900,underlyingClose:800,dataMode:'FYERS_HISTORICAL_CANDLE_REPLAY'};
const candle=(offset,open,high,low,close)=>({time:t0+offset,open,high,low,close,volume:1000,completed:true,source:'FYERS_EXPIRED_FO_5M'});
const optionDataset={source:'FYERS_EXPIRED_FO_API',timestampConvention:'FYERS_EPOCH_BAR_START',actionable:false,ordersEnabled:false,symbol:'NSE:SBIN25MAR800CE',underlying:'NSE:SBIN-EQ',expiry:'2025-03-27',strike:800,side:'CE',selection:{method:'NEAREST_LISTED_STRIKE_TO_COMPLETED_UNDERLYING_CLOSE',selectionTime:signal.evaluatedAt,underlyingPrice:800},requested:{start:'2025-03-26',end:'2025-03-26'},candles:[candle(0,100,105,99,104),candle(300,104,110,103,109),candle(600,108,110,107,109),candle(900,109,111.4,108,111),candle(1200,111,117,110.5,116)]};
const contractSpec={source:'OFFICIAL_EXCHANGE_CONTRACT_MASTER',sha256:'a'.repeat(64),tradeDate:'2025-03-26',sourceUrl:'https://www.nseindia.com/all-reports-derivatives',masterFile:'NSE_FO_contract_26032025.csv.gz',masterFileSha256:'a'.repeat(64),symbol:optionDataset.symbol,underlying:optionDataset.underlying,expiry:optionDataset.expiry,strike:800,side:'CE',tickSize:0.05};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(run){
 const root=await mkdtemp(path.join(os.tmpdir(),'offline-option-worker-'));
 const input=path.join(root,'input'),output=path.join(root,'output');
 await mkdir(input);
 const entries={signal:'signal.json',option:'option.json',spec:'contract-spec.json'};
 const docs={signal,option:optionDataset,spec:contractSpec};
 await writeFile(path.join(input,contractSpec.masterFile),'official NSE daily contract-master test fixture');
 const masterHash=hash(await readFile(path.join(input,contractSpec.masterFile)));
 contractSpec.masterFileSha256=masterHash;contractSpec.sha256=masterHash;
 const hashes={};
 for(const [key,file] of Object.entries(entries)){const bytes=Buffer.from(JSON.stringify(docs[key]));await writeFile(path.join(input,file),bytes);hashes[key]=hash(bytes);}
 const manifest={format:'UPGRADE_AI_PRO_OPTION_EXECUTION_DATASET_V1',source:'FYERS_EXPIRED_FO_API',actionable:false,ordersEnabled:false,complete:true,failureCount:0,datasetId:'test-fixture',entries:[{signalId:'s1',signalFile:entries.signal,signalSha256:hashes.signal,optionFile:entries.option,optionSha256:hashes.option,contractSpecFile:entries.spec,contractSpecSha256:hashes.spec}]};
 await writeFile(path.join(input,'manifest.json'),JSON.stringify(manifest));
 try{return await run({root,input,output,manifest,entries,hashes});}finally{await rm(root,{recursive:true,force:true});}
}

test('offline option worker verifies file hashes and produces non-actionable candle proxy report',async()=>{
 await fixture(async ({input,output})=>{
  const result=await runOfflineOptionExecutionDataset({inputDir:input,outputDir:output});
  assert.equal(result.report.status,'COMPLETE');
  assert.equal(result.report.summary.sampleCount,1);
  assert.equal(result.report.summary.winRate,100);
  assert.equal(result.report.performanceClass,'GROSS_CANDLE_PROXY_NOT_EXECUTABLE');
  assert.equal(result.report.liveStateTouched,false);
  assert.equal(result.report.ordersEnabled,false);
  const saved=JSON.parse(await readFile(result.path,'utf8'));
  assert.equal(saved.results[0].status,'TRADE_CLOSED');
 });
});

test('offline option worker blocks tampered option files before replay',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'offline-option-tamper-'));
 try{
  const input=path.join(root,'input'),output=path.join(root,'output');await mkdir(input);
  const masterFile='NSE_FO_contract_26032025.csv.gz';await writeFile(path.join(input,masterFile),'official NSE daily contract-master test fixture');const masterHash=hash(await readFile(path.join(input,masterFile)));const spec={...contractSpec,masterFile,masterFileSha256:masterHash,sha256:masterHash};const files={signal:JSON.stringify(signal),option:JSON.stringify(optionDataset),spec:JSON.stringify(spec)};
  const hs={};
  for(const [key,value] of Object.entries(files)){await writeFile(path.join(input,key+'.json'),value);hs[key]=hash(value);}
  await writeFile(path.join(input,'option.json'),JSON.stringify({...optionDataset,candles:[]}));
  await writeFile(path.join(input,'manifest.json'),JSON.stringify({format:'UPGRADE_AI_PRO_OPTION_EXECUTION_DATASET_V1',source:'FYERS_EXPIRED_FO_API',actionable:false,ordersEnabled:false,complete:true,failureCount:0,entries:[{signalFile:'signal.json',signalSha256:hs.signal,optionFile:'option.json',optionSha256:hs.option,contractSpecFile:'spec.json',contractSpecSha256:hs.spec}]}));
  await assert.rejects(()=>runOfflineOptionExecutionDataset({inputDir:input,outputDir:output}),/SHA-256 mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('offline option worker rejects overlapping input and output directories',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'offline-option-overlap-'));
 try{await assert.rejects(()=>runOfflineOptionExecutionDataset({inputDir:root,outputDir:path.join(root,'out')}),/non-overlapping/);}
 finally{await rm(root,{recursive:true,force:true});}
});
