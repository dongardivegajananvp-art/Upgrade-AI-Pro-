# UPGRADE AI PRO — Deep Audit Report
Date: 2026-11-24
Scope: repository `dongardivegajananvp-art/Upgrade-AI-Pro-`, production Render service `upgrade-ai-pro` (`srv-dbv6ug1srm7s73bjvgg0`), FYERS-only, NSE-only.
Audit basis: PR #87 documentation branch reviewed against main after PRs #89, #90 and #91 were merged; source review of the offline historical worker and manual GitHub Actions workflow; previously verified Render deployment state.
This is a repository/configuration and available-runtime audit, not a live-market acceptance test.

## Executive result

- PRs #89, #90 and #91 are merged into GitHub `main`. PR #89 adds scheduler/scanner/diagnostic reliability changes; PR #90 closes an NSE quiet-window race in the historical exporter; PR #91 blocks replay of incomplete exports.
- Render production has **not** been updated for those merges. The latest verified Render deployment remains `dep-dc22957f3r2c73e4evhg`, running PR #86 merge commit `6b8f86a3590bf41f792f6b0975a9d7f8d0125947`. Auto-Deploy is OFF.
- No production environment/settings change, live order enablement, or legacy-service change was made.
- The latest available production observation is not proof of trading readiness: all three index ticks were stale, active F&O socket slots were zero, the Data Socket repeatedly closed/reconnected, and successful Option Chain / positions / orderbook responses were not evidenced in the inspected window.
- Broker orders remain disabled. Stale, missing, mismatched or unverified data must remain NO TRADE.
- The historical workflow is manual-dispatch only and has not been run. No dataset or replay results have been generated or validated.

## Verified production baseline (PR #86 deployment)

| Area | Verified state | Interpretation |
|---|---|---|
| Render service | `upgrade-ai-pro`, Free, one instance | Production target; no paid dependency added |
| Deployment | `dep-dc22957f3r2c73e4evhg`, commit `6b8f86a3590bf41f792f6b0975a9d7f8d0125947`, status live | This remains the production version; merged main changes are not live |
| Automation | Auto-Deploy OFF, trigger off | Manual deployment policy preserved |
| Runtime | Node 22.x in `package.json`; PR #87 README correction states Node 22.x | Runtime documentation on PR #87 is aligned |
| REST governor | PR #86 app-side guard: 6 requests / rolling 60 seconds through `src/fyers-rest.js`; lower-priority background/account/scanner/research/warmup work limited to 3/min; 4-second minimum gap and existing recovery/cooldown rules | Conservative app safeguards based on observed 1015; not a claim about FYERS-published quotas. OAuth exchange and public symbol-master download are separate paths |
| FYERS auth / master | Latest PR #89 body records successful OAuth exchange and official NSE/FYERS master load during the 2026-11-24 observation | Authentication and master load do not prove live feed readiness |
| WebSocket | One Data Socket; reconnect and close-event diagnostics improved in PR #89 source, but production still runs PR #86 | Runtime showed repeated close/reconnect and stale indices; new PR #89 diagnostics are not yet in production |
| F&O coverage | 218 mapped underlyings; 20 rotating WebSocket slots; one history-backed underlying/minute scanner admission | Rolling coverage, not simultaneous full-universe live coverage; ideal 218-symbol history pass is at least 218 minutes before delays |
| Orders | Order placement remains disabled | No live order path is authorized |

## Merged main changes not yet deployed

### PR #89 — scheduler fairness and reliability
Merged as `2c1340c9a18b5ea69862cf97347e984831a7ba69`.
- Fair Account / Scanner / Research background scheduling while Entry / Option Chain / Chart retain interactive priority.
- Expired queued requests are rejected before dispatch; identical authenticated GET requests can be coalesced, but POST is not coalesced.
- Scanner pre-admission and retry retention; one new history-backed underlying/minute; 20 rotating WebSocket slots remain rolling.
- Endpoint response-derived health for Option Chain, positions and orderbook, separate setup readiness, WebSocket close details, reconnect configuration before connect.
- Official NSE contract validation across nine strategy IDs and four side/option combinations.
- Positive setup fixtures for all nine strategy IDs and stale-option rejection gates; a negative end-to-end invalidation matrix and explicit daily-history / Top Gainer-membership blockers.
- Browser-session cooldown persistence uses an encrypted Secure/HttpOnly/SameSite=Lax cookie. This is session-scoped, not shared across devices/browsers; a lost 429 response cannot persist its deadline. It is not a globally durable cooldown store.
- PR #89's historical batch implementation is not a live production route; production was not deployed from this PR.

### PR #90 — NSE quiet-window boundary
Merged as `200e7f6d5b75879179600e14e14fd66d121e1e46`.
- Historical exporter rechecks the NSE quiet window after its pacing wait and immediately before the FYERS request.
- Regression test covers a wait that crosses the 08:45 IST boundary.
- No production or live workstation behavior changed.

### PR #91 — incomplete dataset replay rejection
Merged as `8afccd978fc446126d70ed778b59d93e0d87eea8`.
- Offline worker requires `manifest.complete === true`, zero failures, and `exportedCount` equal to the manifest file count.
- Regression test verifies that replay is rejected and the replay callback is not invoked for a partial manifest.
- This is a fail-closed data-integrity guard, not proof that a full export has been completed.

## Historical backtest: exact scope and limitations

### Isolation evidence in source
- `.github/workflows/manual-historical-backtest.yml` is `workflow_dispatch` only and requires the exact confirmation string `RUN_HISTORICAL_BACKTEST`.
- It runs on a GitHub-hosted `ubuntu-latest` runner, not in the Render live service.
- Before any FYERS request, it checks for repository secrets `FYERS_APP_ID` and `FYERS_ACCESS_TOKEN`; the workflow masks them in logs.
- It downloads the official FYERS NSE F&O symbol master, exports official FYERS `/data/history` 5-minute and daily data, requires a complete export, then invokes a separate offline worker and uploads dataset/results as a short-retention artifact.
- `src/backtest-offline-worker.js` imports Node crypto/filesystem/path and the historical replay engine only. It has no FYERS client, REST governor, server, WebSocket, scanner, order manager or live-state imports.
- Worker requires non-overlapping input/output directories; validates manifest provenance, official master source URLs and hashes, sequential request policy, complete export, unique NSE EQ symbols, per-file hashes, FYERS history endpoint evidence, raw-response hashes, exact normalized candle equality, and non-actionable replay output. Results explicitly set `ordersEnabled:false` and `liveStateTouched:false`.
- PR #91 strengthens the complete-manifest check so a partial export cannot be replayed by invoking the worker outside the guarded workflow.

### What this does and does not prove
- Code structure supports separation from the Render live process and live trading state. The workflow has not been executed, so an end-to-end isolation run and actual dataset provenance have not yet been demonstrated.
- SHA-256 values prove file integrity relative to the recorded manifest; they are not a cryptographic FYERS digital signature. Source labels and API evidence are auditable metadata, not independent broker attestation.
- This is **underlying historical signal replay**, not a complete options backtest. It does not simulate historical option contracts/quotes/candles, fills, slippage, fees, Entry/SL/Target execution, P&L, win rate or profit factor.
- Top Gainer membership is not fabricated. Without timestamp-matched historical membership snapshots, that strategy must remain BLOCKED / NOT EVALUATED.
- Do not claim full nine-strategy historical coverage or strategy profitability from this replay.
- The workflow requires repository secrets. Their presence has not been verified; no secrets were read or changed. No credentials should be pasted into chat.
- No workflow run, FYERS historical export, replay, or artifact generation has occurred.

## Live-market acceptance blockers

1. **Index feed:** prove 3/3 fresh exchange-timestamped index ticks during NSE hours with receipt ages and reconnect stability.
2. **F&O feed and scanner:** prove selected underlying ticks, rotation/coverage age, fresh-only Top Gainers, and actual scanner admission/results. Do not label all 218 mapped underlyings as simultaneously live.
3. **Option Chain and Account Feed:** capture successful response-derived health independently for Option Chain, positions and orderbook; absence of log entries is not recovery evidence.
4. **Option and candle pipeline:** prove exact official contract identity (underlying, expiry, strike, CE/PE, lot/tick), fresh option ticks and contiguous completed option candles.
5. **Nine-strategy Entry matrix:** prove positive and negative CE/PE paths across all nine strategies; preserve daily/15m/5m context, freshness, gap/duplicate/session checks and explicit rejection reasons.
6. **Risk ledger:** independently verify Entry, SL, Target, exchange tick rounding, chase guard and RR >= 1:2 after rounding. Missing evidence => NO TRADE.
7. **UI/runtime:** verify PWA update lifecycle, bounded non-overlapping polling, account feed cadence, and status labels that distinguish process health from trade readiness.
8. **Release:** CI + Verify, explicit user approval, manual Render deploy, exact deployed SHA check, market-open acceptance and rollback record.

## Safety and release controls

- FYERS only; NSE only; no synthetic, sample, stale or unverified actionable data.
- Missing, stale or mismatched inputs mean NO TRADE.
- Orders remain disabled.
- Render Auto-Deploy remains OFF. No deployment without explicit user approval.
- No legacy service changes, paid dependencies, or production backtest execution.
- Closed-market tests and a successful Render deploy do not prove live-market readiness.
- This report is documentation only; it does not authorize merge, deployment, secret changes, historical workflow execution or order placement.
