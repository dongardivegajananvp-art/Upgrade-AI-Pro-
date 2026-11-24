import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runOfflineHistoricalDataset } from './backtest-offline-worker.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uapro-backtest-'));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await mkdir(inputDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fiveRaw=Buffer.from(JSON.stringify({s:'ok',candles:[]}));
  const dailyRaw=Buffer.from(JSON.stringify({s:'ok',candles:[]}));
  await writeFile(path.join(inputDir,'sbin-5m-response.json'),fiveRaw);
  await writeFile(path.join(inputDir,'sbin-daily-response.json'),dailyRaw);
  const data = Buffer.from(JSON.stringify({ symbol:'NSE:SBIN-EQ', source:'FYERS_HISTORICAL_API', dataProvenance:'FYERS_HISTORICAL_API', fiveMinuteCandles:[], dailyCandles:[], topGainerMembership:[],rawResponseEvidence:{fiveMinute:{file:'sbin-5m-response.json',sha256:digest(fiveRaw)},daily:{file:'sbin-daily-response.json',sha256:digest(dailyRaw)}},apiEvidence:{fiveMinute:{endpoint:'/data/history',resolution:'5',httpStatus:200,responseSha256:digest(fiveRaw),retrievedAt:'2026-11-24T10:00:00Z'},daily:{endpoint:'/data/history',resolution:'D',httpStatus:200,responseSha256:digest(dailyRaw),retrievedAt:'2026-11-24T10:00:00Z'}} }));
  await writeFile(path.join(inputDir, 'sbin.json'), data);
  const foMaster=Buffer.from('{\"official\":\"fo\"}');
  const cmMaster=Buffer.from('{\"official\":\"cm\"}');
  await writeFile(path.join(inputDir,'master-NSE_FO_sym_master.json'),foMaster);
  await writeFile(path.join(inputDir,'master-NSE_CM_sym_master.json'),cmMaster);
  await writeFile(path.join(inputDir, 'manifest.json'), JSON.stringify({
    format:'UPGRADE_AI_PRO_FYERS_HISTORICAL_DATASET_V1', source:'FYERS_HISTORICAL_API', actionable:false,
    complete:true, exportedCount:1, failureCount:0, failures:[],
    datasetId:'test-fixture', requested:{startTime:1760000000,endTime:1761000000}, master:{source:'FYERS_OFFICIAL_SYMBOL_MASTER',sha256:'a'.repeat(64),sourceFiles:{NSE_FO:{url:'https://public.fyers.in/sym_details/NSE_FO_sym_master.json',datasetFile:'master-NSE_FO_sym_master.json',sha256:digest(foMaster)},NSE_CM:{url:'https://public.fyers.in/sym_details/NSE_CM_sym_master.json',datasetFile:'master-NSE_CM_sym_master.json',sha256:digest(cmMaster)}}}, requestPolicy:{sequential:true},
    files:[{symbol:'NSE:SBIN-EQ',file:'sbin.json',sha256:digest(data)}]
  }));
  return { inputDir, outputDir };
}

test('offline worker replays hash-verified FYERS files and writes results outside input', async t => {
  const dirs = await fixture(t);
  let replayRange = null;
  const out = await runOfflineHistoricalDataset({ ...dirs, replay: ({symbol,startTime,endTime}) => { replayRange={startTime,endTime}; return {status:'DATA_UNAVAILABLE',mode:'HISTORICAL_SIGNAL_REPLAY',actionable:false,symbol,signals:[]}; } });
  assert.equal(out.report.mode, 'OFFLINE_HISTORICAL_SIGNAL_REPLAY');
  assert.equal(out.report.actionable, false);
  assert.equal(out.report.ordersEnabled, false);
  assert.equal(out.report.liveStateTouched, false);
  assert.equal(out.report.symbolCount, 1);
  assert.deepEqual(replayRange,{startTime:1760000000,endTime:1761000000});
  assert.ok(out.path.startsWith(dirs.outputDir + path.sep));
  assert.equal(JSON.parse(await readFile(out.path, 'utf8')).results[0].symbol, 'NSE:SBIN-EQ');
});


test('offline worker refuses a partial exporter manifest before replay', async t => {
  const dirs = await fixture(t);
  const manifestPath = path.join(dirs.inputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.complete = false;
  manifest.exportedCount = 1;
  manifest.failureCount = 1;
  manifest.failures = [{symbol:'NSE:RELIANCE-EQ',reason:'FYERS HTTP 429'}];
  await writeFile(manifestPath, JSON.stringify(manifest));
  let replayCalled = false;
  await assert.rejects(
    runOfflineHistoricalDataset({ ...dirs, replay: () => { replayCalled = true; return {status:'COMPLETE',mode:'HISTORICAL_SIGNAL_REPLAY',actionable:false}; } }),
    /manifest is incomplete or has failed exports/
  );
  assert.equal(replayCalled, false);
});

test('offline worker rejects modified files and provenance mismatch', async t => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.inputDir, 'sbin.json'), JSON.stringify({symbol:'NSE:SBIN-EQ',source:'SYNTHETIC',dataProvenance:'SYNTHETIC'}));
  await assert.rejects(runOfflineHistoricalDataset({ ...dirs }), /SHA-256 mismatch/);
});

test('offline worker rejects normalized candles that disagree with original FYERS response', async t => {
  const dirs = await fixture(t);
  const dataPath=path.join(dirs.inputDir,'sbin.json');
  const data=JSON.parse(await readFile(dataPath,'utf8'));
  data.fiveMinuteCandles=[{time:1,open:1,high:1,low:1,close:1,volume:1,completed:true,source:'FYERS_HISTORY_5M'}];
  const bytes=Buffer.from(JSON.stringify(data));
  await writeFile(dataPath,bytes);
  const manifestPath=path.join(dirs.inputDir,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.files[0].sha256=digest(bytes);
  await writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(runOfflineHistoricalDataset({ ...dirs }), /Normalized candle data does not match original FYERS response/);
});

test('offline worker rejects modified original FYERS response bytes', async t => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.inputDir,'sbin-5m-response.json'),JSON.stringify({s:'ok',candles:[[1,1,1,1,1,1]]}));
  await assert.rejects(runOfflineHistoricalDataset({ ...dirs }), /Original FYERS fiveMinute response SHA-256 mismatch/);
});

test('offline worker rejects path traversal and overlapping input/output locations', async t => {
  const dirs = await fixture(t);
  const manifestPath = path.join(dirs.inputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[0].file = '../sbin.json';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(runOfflineHistoricalDataset({ ...dirs }), /filename is invalid/);
  await assert.rejects(runOfflineHistoricalDataset({ inputDir:dirs.inputDir, outputDir:dirs.inputDir }), /must be separate/);
});

test('offline worker has no imports of live server, FYERS REST, WebSocket, scanner or order modules', async t => {
  const source = await readFile(new URL('./backtest-offline-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fyers-rest|fyers-market-socket|rolling-fno-scanner|server\\.js|order-manager|placeOrder/);
});
