# UPGRADE AI PRO — isolated historical replay

## Safety boundary

There are two separate commands and processes:

- `npm run backtest:export -- <official-master.json> <dataset-dir>` downloads historical candles using only the explicitly supplied FYERS credentials. Run this on a separate machine/process, preferably outside NSE market hours. It does not import the live server, FYERS REST governor, WebSocket, scanner, account feed, or order manager.
- `npm run backtest:offline -- <dataset-dir> <results-dir>` performs local replay. It has no network client and reads only the exported files.

Never run either command as a child process inside the live trading server. The live production process remains independent. The exporter uses its own sequential HTTP calls and pacing; it does not share or consume the live app's in-memory REST governor. A separate process does not mean FYERS account-level limits are independent: the broker may apply shared account/app quotas, so export only off-market, monitor responses, and stop immediately on HTTP 429/401/403. The exporter makes no automatic retries.

## Credentials

Set `FYERS_APP_ID` and `FYERS_ACCESS_TOKEN` as environment variables in the isolated shell only. Do not commit them, put them in command arguments, or paste them into logs. The access token is read directly from the environment; it is never written to the dataset or report. Authenticate through the user's normal FYERS OAuth process and use the resulting valid token. The exporter does not change the live workstation's authentication/session.

## Official instrument master input

First download and map the current FYERS NSE F&O and NSE Capital Market symbol masters:

`npm run backtest:master -- ./fyers-master`

This reads the official public FYERS JSON URLs for `NSE_FO` and `NSE_CM`, stores the exact raw files, records their SHA-256 hashes and retrieval time, then maps `NSE_FO.underFyTok` to `NSE_CM.fyToken`. Only active NSE cash-market `-EQ` instruments with a matching F&O underlying token are included. The mapper refuses to call the universe complete if fewer than 50 equities map. The resulting `official-master.json` is the required input for the historical exporter.

The master schema is:

```json
{
  "format": "UPGRADE_AI_PRO_FYERS_NSE_FNO_MASTER_V1",
  "source": "FYERS_HISTORICAL_API",
  "verifiedOfficialMaster": true,
  "retrievedAt": "ISO-8601 timestamp",
  "symbols": ["NSE:SBIN-EQ"]
}
```

The exporter itself downloads both official masters and records the raw-file hashes and URLs. The hashes attest to downloaded bytes but are not a FYERS digital signature. Do not substitute a manually guessed list or current Top Gainers.

## Export behavior

For each official symbol, sequentially fetches FYERS `/data/history` resolution `5` and `D`. The requested replay period is three calendar months; 5-minute history includes five extra calendar days for warm-up, and daily history includes 120 extra calendar days. Requests are sequential with a conservative 4-second default spacing, configurable only within 1–60 seconds. This spacing is an app-side precaution, not a statement of FYERS quota. FYERS documented request limits are checked locally (100 days intraday and 366 days daily). A 429/401/403 stops the export immediately with no retry.

The exporter stores normalized completed candles plus SHA-256 hashes of each exact raw FYERS response, request resolution/date range, HTTP status and retrieval timestamp. Invalid rows, duplicate timestamps, missing candles, insufficient daily warm-up or non-JSON/error responses are rejected. No candles are interpolated or synthesized. Failed symbols are listed in the manifest; a partial dataset must not be represented as a complete-universe backtest.

The dataset manifest also stores the exact instrument-master file hash. The offline worker verifies dataset-file hashes and checks that the FYERS response evidence fields are present and correctly shaped before replay.

**Provenance caveat:** hashes establish integrity after export; they do not independently prove broker origin because a local operator could fabricate both data and manifest. The raw API response hashes and metadata improve auditability, but they are not a FYERS digital signature. Retain the original export environment/logs and do not manually edit files. The operator must ensure the input master is official.

## Run commands

Example on an isolated machine after installing the repository dependencies and setting credentials securely in that shell:

```sh
npm run backtest:master -- ./fyers-master\nnpm run backtest:export -- ./fyers-master/official-master.json ./fyers-dataset
npm run backtest:offline -- ./fyers-dataset ./backtest-results
```

Use the offline replay only when the export manifest reports `complete: true`. The exporter currently gathers underlying equity candles only. Historical Top Gainer membership is not reconstructed; the Top Gainer strategy is evaluated only if timestamp-matched historical membership snapshots are later added from a verified source. No present-day gainer list is backfilled into history.

## Output and limitations

Results are written atomically to the separate output directory. Reports are marked `OFFLINE_HISTORICAL_SIGNAL_REPLAY`, `actionable: false`, `ordersEnabled: false`, and `liveStateTouched: false`. This is underlying-signal replay only; it does not calculate historical option contract fills, option entry/SL/target, P&L, win rate, or profit factor. It does not claim a complete options strategy backtest.

No production service, deployment, merge, or live order flow is changed by running these tools. No paid service is required.
