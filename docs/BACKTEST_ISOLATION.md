# UPGRADE AI PRO — isolated historical replay

## Safety boundary

The historical replay worker is a separate Node.js process invoked with `npm run backtest:offline -- <input-dir> <output-dir>`. It imports only the historical replay engine and Node.js filesystem/crypto modules. It does not import the live server, FYERS REST governor/client, WebSocket, scanner, account feed, order manager, or live state.

Run this worker on a separate local machine/process or isolated compute environment. Do not run it as a child process inside the production live server. The output directory must be separate from and non-overlapping with the input directory. The worker never calls FYERS or any network endpoint.

## Dataset layout

The input directory must contain:

- `manifest.json`
- one JSON file per NSE F&O equity symbol, each named by a safe basename

Manifest example:

```json
{
  "format": "UPGRADE_AI_PRO_FYERS_HISTORICAL_DATASET_V1",
  "source": "FYERS_HISTORICAL_API",
  "actionable": false,
  "datasetId": "descriptive-id",
  "startTime": 0,
  "endTime": 0,
  "files": [
    { "symbol": "NSE:SBIN-EQ", "file": "sbin.json", "sha256": "64-lowercase-hex-characters" }
  ]
}
```

Each symbol file must include `symbol`, `source: "FYERS_HISTORICAL_API"`, `dataProvenance: "FYERS_HISTORICAL_API"`, `fiveMinuteCandles`, `dailyCandles`, and optional timestamp-matched `topGainerMembership`. The SHA-256 value is calculated over the exact file bytes.

## Important provenance limitation

A SHA-256 check detects file changes after a manifest was created; it does **not** prove that a file genuinely came from FYERS. The current worker therefore validates provenance labels, integrity, symbols, and replay-engine candle gates, but it cannot independently authenticate the broker origin. Do not label a dataset as official until a separate, audited FYERS historical downloader/exporter records the exact API response and provenance. Synthetic/sample data must never be used. Missing or invalid candles remain `DATA_UNAVAILABLE`.

## Output

Results are written atomically to the separate output directory. Reports are marked `OFFLINE_HISTORICAL_SIGNAL_REPLAY`, `actionable: false`, `ordersEnabled: false`, and `liveStateTouched: false`. This is underlying-signal replay only; it does not calculate option fills, entry/SL/target, P&L, win rate, or profit factor.

No production service, deployment, merge, or live order flow is changed by running this worker.
