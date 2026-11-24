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
  const data = Buffer.from(JSON.stringify({ symbol:'NSE:SBIN-EQ', source:'FYERS_HISTORICAL_API', dataProvenance:'FYERS_HISTORICAL_API', fiveMinuteCandles:[], dailyCandles:[], topGainerMembership:[],apiEvidence:{fiveMinute:{endpoint:'/data/history',resolution:'5',httpStatus:200,responseSha256:'b'.repeat(64),retrievedAt:'2026-11-24T10:00:00Z'},daily:{endpoint:'/data/history',resolution:'D',httpStatus:200,responseSha256:'c'.repeat(64),retrievedAt:'2026-11-24T10:00:00Z'}} }));
  await writeFile(path.join(inputDir, 'sbin.json'), data);
  await writeFile(path.join(inputDir, 'manifest.json'), JSON.stringify({
    format:'UPGRADE_AI_PRO_FYERS_HISTORICAL_DATASET_V1', source:'FYERS_HISTORICAL_API', actionable:false,
    datasetId:'test-fixture', startTime:1, endTime:2, master:{source:'FYERS_OFFICIAL_SYMBOL_MASTER',sha256:'a'.repeat(64),sourceFiles:{NSE_FO:{url:'https://public.fyers.in/sym_details/NSE_FO_sym_master.json',sha256:'b'.repeat(64)},NSE_CM:{url:'https://public.fyers.in/sym_details/NSE_CM_sym_master.json',sha256:'c'.repeat(64)}}}, requestPolicy:{sequential:true},
    files:[{symbol:'NSE:SBIN-EQ',file:'sbin.json',sha256:digest(data)}]
  }));
  return { inputDir, outputDir };
}

test('offline worker replays hash-verified FYERS files and writes results outside input', async t => {
  const dirs = await fixture(t);
  const out = await runOfflineHistoricalDataset({ ...dirs, replay: ({symbol}) => ({status:'DATA_UNAVAILABLE',mode:'HISTORICAL_SIGNAL_REPLAY',actionable:false,symbol,signals:[]}) });
  assert.equal(out.report.mode, 'OFFLINE_HISTORICAL_SIGNAL_REPLAY');
  assert.equal(out.report.actionable, false);
  assert.equal(out.report.ordersEnabled, false);
  assert.equal(out.report.liveStateTouched, false);
  assert.equal(out.report.symbolCount, 1);
  assert.ok(out.path.startsWith(dirs.outputDir + path.sep));
  assert.equal(JSON.parse(await readFile(out.path, 'utf8')).results[0].symbol, 'NSE:SBIN-EQ');
});

test('offline worker rejects modified files and provenance mismatch', async t => {
  const dirs = await fixture(t);
  await writeFile(path.join(dirs.inputDir, 'sbin.json'), JSON.stringify({symbol:'NSE:SBIN-EQ',source:'SYNTHETIC',dataProvenance:'SYNTHETIC'}));
  await assert.rejects(runOfflineHistoricalDataset({ ...dirs }), /SHA-256 mismatch/);
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
