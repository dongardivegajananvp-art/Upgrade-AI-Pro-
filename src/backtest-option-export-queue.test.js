import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildOptionExportQueue, createOfflineOptionExportQueue } from './backtest-option-export-queue.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const signal = {
  symbol:'NSE:SBIN-EQ',strategy:'EMA20_EMA50_TREND',side:'LONG',
  confirmedAt:1742961300,evaluatedAt:1742961600,underlyingClose:800,
  dataMode:'FYERS_HISTORICAL_CANDLE_REPLAY',optionExecution:'NOT_SIMULATED',
  entry:null,stopLoss:null,target:null,pnl:null
};
const report = (signals=[signal]) => ({
  format:'UPGRADE_AI_PRO_HISTORICAL_REPLAY_RESULTS_V1',
  mode:'OFFLINE_HISTORICAL_SIGNAL_REPLAY',source:'FYERS_HISTORICAL_API',
  status:'COMPLETE',actionable:false,ordersEnabled:false,liveStateTouched:false,
  results:[{symbol:'NSE:SBIN-EQ',source:'FYERS_HISTORICAL_API',mode:'HISTORICAL_SIGNAL_REPLAY',signals}]
});

test('queue preserves exact FYERS replay signal identity, time, side and underlying close',()=>{
 const result=buildOptionExportQueue({report:report(),reportSha256:'a'.repeat(64)});
 assert.equal(result.status,'READY');
 assert.equal(result.taskCount,1);
 assert.equal(result.tasks[0].underlying,'NSE:SBIN-EQ');
 assert.equal(result.tasks[0].optionSide,'CE');
 assert.equal(result.tasks[0].selectionTime,signal.evaluatedAt);
 assert.equal(result.tasks[0].underlyingPrice,800);
 assert.equal(result.tasks[0].expiryResolution,'PENDING_FYERS_EXPIRY_CATALOG');
 assert.equal(result.actionable,false);
 assert.equal(result.ordersEnabled,false);
});

test('Top Gainer is blocked unless timestamp-matched membership proof is carried',()=>{
 const top={...signal,strategy:'TOP_GAINER_MOMENTUM_BREAKOUT'};
 const result=buildOptionExportQueue({report:report([top]),reportSha256:'b'.repeat(64)});
 assert.equal(result.status,'BLOCKED');
 assert.equal(result.taskCount,0);
 assert.match(result.rejected[0].reason,/timestamp-matched membership snapshot/);
});

test('malformed or non-FYERS signals are rejected rather than synthesized',()=>{
 const bad={...signal,dataMode:'SYNTHETIC'};
 const result=buildOptionExportQueue({report:report([bad]),reportSha256:'c'.repeat(64)});
 assert.equal(result.status,'BLOCKED');
 assert.equal(result.taskCount,0);
 assert.equal(result.rejectedCount,1);
});

test('partial source report stays PARTIAL even when valid signals are queued',()=>{
 const source=report();source.status='PARTIAL';
 const result=buildOptionExportQueue({report:source,reportSha256:'d'.repeat(64)});
 assert.equal(result.status,'PARTIAL');
 assert.equal(result.taskCount,1);
});

test('queue writer copies and hashes source report and every signal in separate directory',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'option-queue-'));
 try{
  const input=path.join(root,'reports'),output=path.join(root,'queue');
  await mkdir(input);
  const bytes=Buffer.from(JSON.stringify(report()));
  const reportFile=path.join(input,'historical-report.json');
  await writeFile(reportFile,bytes);
  const result=await createOfflineOptionExportQueue({signalReportFile:reportFile,outputDir:output});
  assert.equal(result.manifest.status,'READY');
  const saved=JSON.parse(await readFile(path.join(output,'manifest.json'),'utf8'));
  assert.equal(saved.entries.length,1);
  assert.equal(saved.sourceReport.sha256,hash(bytes));
  const signalBytes=await readFile(path.join(output,saved.entries[0].signalFile));
  assert.equal(hash(signalBytes),saved.entries[0].signalSha256);
  assert.equal(JSON.parse(signalBytes.toString()).confirmedAt,signal.confirmedAt);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('queue writer rejects overlapping input and output directories',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'option-queue-overlap-'));
 try{
  const reportFile=path.join(root,'report.json');
  await writeFile(reportFile,JSON.stringify(report()));
  await assert.rejects(()=>createOfflineOptionExportQueue({signalReportFile:reportFile,outputDir:path.join(root,'queue')}),/separate, non-overlapping/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('queue builder rejects reports without complete FYERS provenance and safety flags',()=>{
 const bad=report();bad.ordersEnabled=true;
 assert.throws(()=>buildOptionExportQueue({report:bad,reportSha256:'e'.repeat(64)}),/hashed, non-actionable FYERS/);
});
