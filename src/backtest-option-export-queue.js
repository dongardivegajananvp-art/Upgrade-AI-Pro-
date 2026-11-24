import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const REPORT_FORMAT = 'UPGRADE_AI_PRO_HISTORICAL_REPLAY_RESULTS_V1';
const QUEUE_FORMAT = 'UPGRADE_AI_PRO_OPTION_EXPORT_QUEUE_V1';
const PROVENANCE = 'FYERS_HISTORICAL_API';
const STRATEGIES = new Set([
  'EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',
  'BULLISH_CONTINUATION','BEARISH_CONTINUATION','FLAG_BREAKOUT_VOLUME',
  'OPENING_RANGE_BREAKOUT'
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const istDate = seconds => new Date((Number(seconds) + 19800) * 1000).toISOString().slice(0, 10);
const safeJsonName = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,100}\.json$/.test(value) || value.includes('..')) {
    throw new Error('Option queue filename is invalid');
  }
  return value;
};
async function writeOnce(file, bytes) {
  try {
    const prior = await readFile(file);
    if (!prior.equals(bytes)) throw new Error('OPTION_QUEUE_ARCHIVE_CONFLICT: refusing to overwrite different evidence');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = file + '.tmp';
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, file);
}

/**
 * Converts a verified offline FYERS underlying replay report into immutable
 * per-signal option-export tasks. This does not call FYERS or simulate trades.
 * Top Gainer tasks are held until the exact timestamped membership snapshot is
 * carried into the source evidence; current replay reports do not carry it.
 */
export function buildOptionExportQueue({ report, reportSha256, generatedAt = new Date().toISOString() } = {}) {
  if (!report || report.format !== REPORT_FORMAT || report.mode !== 'OFFLINE_HISTORICAL_SIGNAL_REPLAY' ||
      report.source !== PROVENANCE || report.actionable !== false || report.ordersEnabled !== false ||
      report.liveStateTouched !== false || !Array.isArray(report.results) ||
      !/^[a-f0-9]{64}$/.test(reportSha256 || '')) {
    throw new Error('A hashed, non-actionable FYERS offline historical replay report is required');
  }
  const tasks = [];
  const rejected = [];
  const seen = new Set();
  for (const result of report.results) {
    if (!result || result.source !== PROVENANCE || result.mode !== 'HISTORICAL_SIGNAL_REPLAY' ||
        !/^NSE:[A-Z0-9&._-]{1,48}-EQ$/.test(String(result.symbol || '')) ||
        !Array.isArray(result.signals)) {
      rejected.push({ symbol: String(result?.symbol || 'UNKNOWN'), reason: 'INVALID_OR_UNVERIFIED_UNDERLYING_REPLAY_RESULT' });
      continue;
    }
    for (const signal of result.signals) {
      const strategy = String(signal?.strategy || '');
      const symbol = String(signal?.symbol || '').toUpperCase();
      const confirmedAt = Number(signal?.confirmedAt);
      const evaluatedAt = Number(signal?.evaluatedAt);
      const underlyingClose = Number(signal?.underlyingClose);
      const valid = STRATEGIES.has(strategy) && symbol === result.symbol &&
        /^NSE:[A-Z0-9&._-]{1,48}-EQ$/.test(symbol) &&
        ['LONG','SHORT'].includes(signal?.side) &&
        Number.isSafeInteger(confirmedAt) && Number.isSafeInteger(evaluatedAt) &&
        evaluatedAt === confirmedAt + 300 && Number.isFinite(underlyingClose) && underlyingClose > 0 &&
        signal?.dataMode === 'FYERS_HISTORICAL_CANDLE_REPLAY' &&
        signal?.optionExecution === 'NOT_SIMULATED' &&
        signal?.entry === null && signal?.stopLoss === null && signal?.target === null && signal?.pnl === null;
      if (!valid) {
        rejected.push({ symbol, strategy, confirmedAt: Number.isFinite(confirmedAt) ? confirmedAt : null, reason: 'SIGNAL_FIELDS_OR_FYERS_REPLAY_PROVENANCE_INVALID' });
        continue;
      }
      if (strategy === 'TOP_GAINER_MOMENTUM_BREAKOUT') {
        rejected.push({ symbol, strategy, confirmedAt, reason: 'TOP_GAINER_NOT_QUEUED: timestamp-matched membership snapshot is not embedded in the source replay report' });
        continue;
      }
      const signalId = [strategy, symbol, confirmedAt].join(':');
      if (seen.has(signalId)) {
        rejected.push({ symbol, strategy, confirmedAt, reason: 'DUPLICATE_SIGNAL_IDENTITY' });
        continue;
      }
      seen.add(signalId);
      tasks.push({
        signalId,
        signal,
        underlying: symbol,
        tradeDate: istDate(evaluatedAt),
        optionSide: signal.side === 'LONG' ? 'CE' : 'PE',
        selectionTime: evaluatedAt,
        underlyingPrice: underlyingClose,
        expiryResolution: 'PENDING_FYERS_EXPIRY_CATALOG',
        exportStatus: 'QUEUED',
        expectedProviderRequests: 4,
        note: 'Provider expiry and exact contract must be discovered from FYERS expired-F&O catalog; never infer a contract symbol'
      });
    }
  }
  return {
    format: QUEUE_FORMAT,
    status: tasks.length === 0 ? (rejected.length ? 'BLOCKED' : 'EMPTY') :
      (rejected.length || report.status !== 'COMPLETE' ? 'PARTIAL' : 'READY'),
    source: PROVENANCE,
    sourceReportSha256: reportSha256,
    generatedAt,
    actionable: false,
    ordersEnabled: false,
    liveStateTouched: false,
    taskCount: tasks.length,
    rejectedCount: rejected.length,
    tasks,
    rejected,
    constraints: [
      'Queue construction is offline only; no FYERS request is made.',
      'Each task uses the completed underlying candle close and exact evaluation timestamp from the replay signal.',
      'The expiry and contract symbol must be discovered from FYERS expired-F&O APIs; no option symbol or expiry is synthesized.',
      'The expired-option exporter collects CE and PE as a pair (4 provider requests); Standard daily request budget and persistent ledger remain mandatory.',
      'Top Gainer tasks remain blocked until timestamp-matched membership evidence is preserved.',
      'This queue is not an execution report, backtest result, trade recommendation or order instruction.'
    ]
  };
}

export async function createOfflineOptionExportQueue({ signalReportFile, outputDir } = {}) {
  if (!signalReportFile || !outputDir) throw new Error('A signal report file and separate output directory are required');
  const reportPath = path.resolve(signalReportFile);
  const inputRoot = path.dirname(reportPath);
  const outputRoot = path.resolve(outputDir);
  if (outputRoot === inputRoot || outputRoot.startsWith(inputRoot + path.sep) || inputRoot.startsWith(outputRoot + path.sep)) {
    throw new Error('Signal report input and option queue output must be in separate, non-overlapping directories');
  }
  const reportBytes = await readFile(reportPath);
  let report;
  try { report = JSON.parse(reportBytes.toString('utf8')); }
  catch { throw new Error('Historical signal report is not valid JSON'); }
  const reportHash = sha256(reportBytes);
  const queue = buildOptionExportQueue({ report, reportSha256: reportHash });
  await mkdir(outputRoot, { recursive: true });
  await writeOnce(path.join(outputRoot, 'source-report.json'), reportBytes);
  const entries = [];
  for (let index = 0; index < queue.tasks.length; index += 1) {
    const task = queue.tasks[index];
    const file = safeJsonName('signal-' + String(index + 1).padStart(5, '0') + '.json');
    const bytes = Buffer.from(JSON.stringify(task.signal, null, 2) + '\n');
    await writeOnce(path.join(outputRoot, file), bytes);
    entries.push({
      signalId: task.signalId,
      signalFile: file,
      signalSha256: sha256(bytes),
      underlying: task.underlying,
      tradeDate: task.tradeDate,
      optionSide: task.optionSide,
      selectionTime: task.selectionTime,
      underlyingPrice: task.underlyingPrice,
      expiryResolution: task.expiryResolution,
      exportStatus: task.exportStatus,
      expectedProviderRequests: task.expectedProviderRequests
    });
  }
  const manifest = {
    format: queue.format,
    status: queue.status,
    source: queue.source,
    sourceReport: { file: 'source-report.json', sha256: reportHash },
    generatedAt: queue.generatedAt,
    actionable: false,
    ordersEnabled: false,
    liveStateTouched: false,
    complete: queue.status === 'READY',
    taskCount: queue.taskCount,
    rejectedCount: queue.rejectedCount,
    entries,
    rejected: queue.rejected,
    constraints: queue.constraints
  };
  await writeOnce(path.join(outputRoot, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { outputDir: outputRoot, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [signalReportFile, outputDir] = process.argv.slice(2);
  createOfflineOptionExportQueue({ signalReportFile, outputDir })
    .then(({ outputDir: dir, manifest }) => {
      process.stdout.write(JSON.stringify({ status: manifest.status, outputDir: dir, taskCount: manifest.taskCount, rejectedCount: manifest.rejectedCount, actionable: false, ordersEnabled: false }) + '\n');
      if (manifest.status !== 'READY') process.exitCode = 2;
    })
    .catch(error => {
      process.stderr.write(JSON.stringify({ status: 'DATA_UNAVAILABLE', reason: String(error?.message || error).slice(0, 300), actionable: false, ordersEnabled: false }) + '\n');
      process.exitCode = 1;
    });
}
