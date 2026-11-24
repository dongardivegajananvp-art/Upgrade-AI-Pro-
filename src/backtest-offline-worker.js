import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { runHistoricalSignalReplay } from './backtest-engine.js';

const FORMAT = 'UPGRADE_AI_PRO_FYERS_HISTORICAL_DATASET_V1';
const PROVENANCE = 'FYERS_HISTORICAL_API';
const SYMBOL = /^NSE:[A-Z0-9&._-]{1,48}-EQ$/;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function safeName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,100}\.json$/.test(value) || value.includes('..')) {
    throw new Error('Dataset filename is invalid');
  }
  return value;
}

/** Offline-only worker. It has no FYERS client, REST governor, server, WebSocket,
 * scanner, order, or live-state imports. Input files are immutable snapshots. */
export async function runOfflineHistoricalDataset({ inputDir, outputDir, replay = runHistoricalSignalReplay } = {}) {
  if (!inputDir || !outputDir) throw new Error('Separate inputDir and outputDir are required');
  const input = path.resolve(inputDir);
  const output = path.resolve(outputDir);
  if (input === output || output.startsWith(input + path.sep) || input.startsWith(output + path.sep)) {
    throw new Error('Historical input and output directories must be separate and non-overlapping');
  }
  const manifestBytes = await readFile(path.join(input, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== FORMAT || manifest.source !== PROVENANCE || manifest.actionable !== false) {
    throw new Error('Dataset manifest is not an explicitly non-actionable FYERS historical export');
  }
  if (!manifest.master || manifest.master.source !== 'FYERS_OFFICIAL_SYMBOL_MASTER' || !/^[a-f0-9]{64}$/.test(manifest.master.sha256 || '') || manifest.master.sourceFiles?.NSE_FO?.url !== 'https://public.fyers.in/sym_details/NSE_FO_sym_master.json' || manifest.master.sourceFiles?.NSE_CM?.url !== 'https://public.fyers.in/sym_details/NSE_CM_sym_master.json' || !/^[a-f0-9]{64}$/.test(manifest.master.sourceFiles?.NSE_FO?.sha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.master.sourceFiles?.NSE_CM?.sha256 || '') || !manifest.requestPolicy || manifest.requestPolicy.sequential !== true) {
    throw new Error('Dataset is missing official-master integrity evidence or sequential export policy');
  }
  for (const name of ['NSE_FO','NSE_CM']) {
    const source=manifest.master.sourceFiles[name];
    const filename=safeName(source.datasetFile);
    if (sha256(await readFile(path.join(input,filename)))!==source.sha256) throw new Error('Bundled official FYERS '+name+' master SHA-256 mismatch');
  }
  if (manifest.complete !== true || Number(manifest.failureCount) !== 0 || Number(manifest.exportedCount) !== manifest.files?.length) {
    throw new Error('Historical dataset manifest is incomplete or has failed exports; replay is blocked');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 300) {
    throw new Error('Dataset manifest must contain 1 to 300 symbol files');
  }
  const replayRange = manifest.requested || { startTime: manifest.startTime, endTime: manifest.endTime };
  const replayStartTime = Number(replayRange?.startTime);
  const replayEndTime = Number(replayRange?.endTime);
  if (!Number.isFinite(replayStartTime) || !Number.isFinite(replayEndTime) || replayStartTime <= 0 || replayEndTime <= replayStartTime) {
    throw new Error('Dataset manifest is missing a valid requested replay start/end range');
  }
  const seen = new Set();
  const results = [];
  for (const entry of manifest.files) {
    const filename = safeName(entry?.file);
    const symbol = String(entry?.symbol || '').toUpperCase();
    if (!SYMBOL.test(symbol) || seen.has(symbol)) throw new Error('Dataset contains an invalid or duplicate official NSE F&O equity symbol');
    seen.add(symbol);
    const bytes = await readFile(path.join(input, filename));
    if (sha256(bytes) !== entry.sha256) throw new Error('Dataset SHA-256 mismatch for ' + symbol);
    const data = JSON.parse(bytes.toString('utf8'));
    if (data.symbol !== symbol || data.dataProvenance !== PROVENANCE || data.source !== PROVENANCE) {
      throw new Error('Historical file provenance/symbol mismatch for ' + symbol);
    }
    const evidence = data.apiEvidence;
    const validEvidence = proof => proof && proof.endpoint === '/data/history' && proof.httpStatus === 200 && /^[a-f0-9]{64}$/.test(proof.responseSha256 || '') && typeof proof.retrievedAt === 'string';
    if (!validEvidence(evidence?.fiveMinute) || evidence.fiveMinute.resolution !== '5' || !validEvidence(evidence?.daily) || evidence.daily.resolution !== 'D') {
      throw new Error('FYERS API response evidence is missing or invalid for ' + symbol);
    }
    const rawEvidence=data.rawResponseEvidence;
    for (const [kind,proof] of [['fiveMinute',evidence.fiveMinute],['daily',evidence.daily]]) {
      const rawFile=safeName(rawEvidence?.[kind]?.file);
      const rawBytes=await readFile(path.join(input,rawFile));
      const rawHash=sha256(rawBytes);
      if (rawHash!==rawEvidence[kind].sha256 || rawHash!==proof.responseSha256) throw new Error('Original FYERS '+kind+' response SHA-256 mismatch for '+symbol);
      let rawBody;
      try { rawBody=JSON.parse(rawBytes.toString('utf8')); } catch { throw new Error('Original FYERS '+kind+' response is not valid JSON for '+symbol); }
      if (rawBody.s!=='ok' || !Array.isArray(rawBody.candles)) throw new Error('Original FYERS '+kind+' response payload is invalid for '+symbol);
    }
    const expectedFromRaw = (kind, source) => {
      const rawBytes = source.bytes;
      const body = JSON.parse(rawBytes.toString('utf8'));
      const rows = body.candles;
      if (!Array.isArray(rows)) throw new Error('Original FYERS '+kind+' candles array is missing for '+symbol);
      return rows.map(row => {
        if (!Array.isArray(row) || row.length < 6) throw new Error('Original FYERS '+kind+' candle row is malformed for '+symbol);
        const [time,open,high,low,close,volume] = row.map(Number);
        if (![time,open,high,low,close,volume].every(Number.isFinite)) throw new Error('Original FYERS '+kind+' candle row contains non-numeric values for '+symbol);
        return {time,open,high,low,close,volume,completed:true,source:kind==='fiveMinute'?'FYERS_HISTORY_5M':'FYERS_DAILY_HISTORY'};
      }).sort((a,b)=>a.time-b.time);
    };
    const fiveRawBytes = await readFile(path.join(input, safeName(rawEvidence.fiveMinute.file)));
    const dailyRawBytes = await readFile(path.join(input, safeName(rawEvidence.daily.file)));
    const fiveExpected = expectedFromRaw('fiveMinute',{bytes:fiveRawBytes});
    const dailyExpected = expectedFromRaw('daily',{bytes:dailyRawBytes});
    if (JSON.stringify(fiveExpected)!==JSON.stringify(data.fiveMinuteCandles) || JSON.stringify(dailyExpected)!==JSON.stringify(data.dailyCandles)) {
      throw new Error('Normalized candle data does not match original FYERS response for '+symbol);
    }
    const result = replay({
      symbol,
      fiveMinuteCandles: data.fiveMinuteCandles,
      dailyCandles: data.dailyCandles,
      topGainerMembership: data.topGainerMembership || [],
      dataProvenance: data.dataProvenance,
      startTime: replayStartTime,
      endTime: replayEndTime
    });
    if (result.actionable !== false || result.mode !== 'HISTORICAL_SIGNAL_REPLAY') {
      throw new Error('Replay engine returned an unexpected actionable or non-historical result');
    }
    results.push({ symbol, ...result, actionable: false, ordersEnabled: false, source: PROVENANCE });
  }
  const report = {
    format: 'UPGRADE_AI_PRO_HISTORICAL_REPLAY_RESULTS_V1',
    mode: 'OFFLINE_HISTORICAL_SIGNAL_REPLAY',
    source: PROVENANCE,
    datasetId: String(manifest.datasetId || 'UNSPECIFIED'),
    generatedAt: new Date().toISOString(),
    actionable: false,
    ordersEnabled: false,
    liveStateTouched: false,
    symbolCount: results.length,
    completeCount: results.filter(row => row.status === 'COMPLETE').length,
    unavailableCount: results.filter(row => row.status !== 'COMPLETE').length,
    results
  };
  await mkdir(output, { recursive: true });
  const target = path.join(output, 'result-' + Date.now() + '.json');
  const temporary = target + '.tmp';
  await writeFile(temporary, JSON.stringify(report, null, 2), { flag: 'wx' });
  await rename(temporary, target);
  return { path: target, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [inputDir, outputDir] = process.argv.slice(2);
  runOfflineHistoricalDataset({ inputDir, outputDir })
    .then(({ path: resultPath, report }) => {
      process.stdout.write(JSON.stringify({ status: 'COMPLETE', resultPath, symbolCount: report.symbolCount, actionable: false, ordersEnabled: false }) + '\\n');
    })
    .catch(error => {
      process.stderr.write(JSON.stringify({ status: 'DATA_UNAVAILABLE', reason: String(error?.message || error).slice(0, 300), actionable: false, ordersEnabled: false }) + '\\n');
      process.exitCode = 1;
    });
}
