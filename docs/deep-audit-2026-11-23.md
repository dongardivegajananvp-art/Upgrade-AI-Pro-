# UPGRADE AI PRO — Deep Audit Report
Date: 2026-11-23
Scope: repository `dongardivegajananvp-art/Upgrade-AI-Pro-`, production Render service `upgrade-ai-pro` (`srv-dbv6ug1srm7s73bjvgg0`), FYERS-only, NSE-only.
Audit basis: current `main` tree at `6b8f86a3590bf41f792f6b0975a9d7f8d0125947`, PR #85/#86 metadata and diffs, GitHub Actions run, Render deploy/events/logs, and source review.
This is a code/configuration and available-runtime audit, not a live-market acceptance test.

## Executive result

- Production service is LIVE on Render at `https://upgrade-ai-pro.onrender.com`; deployed commit is PR #86 merge commit `6b8f86a3590bf41f792f6b0975a9d7f8d0125947`.
- Render Auto-Deploy is OFF. No production deploy, environment-variable change, or order enablement was performed during this audit.
- PR #86 main-branch CI passed. Render build and deploy events succeeded.
- The latest available runtime logs are not proof of live trading readiness: all three index ticks were stale; F&O active socket slots were zero; Option Chain and Account Feed successful response paths were not evidenced in the post-deploy log window.
- Orders remain disabled. NO TRADE remains the only safe status until live evidence passes.

## Verified facts

| Area | Verified state | Audit interpretation |
|---|---|---|
| Runtime | Node engine 22.x; Render build uses `npm install`, start uses `npm start`; service listened on port 10000 | Runtime configuration is internally aligned; README had a stale Node 20+ statement, corrected in this audit branch |
| Deployment | PR #86 merge SHA deployed; Render deploy status `live`; event `deploy_ended/succeeded` | Server deployment is verified, not market pipeline |
| Automation | Render `autoDeploy=no`, trigger `off` | Manual deploy policy preserved |
| REST governor | 6 upstream requests / rolling 60 seconds across the `fyers-rest.js` scheduler; background/account/scanner/research/warmup limited to 3/min, leaving interactive priority headroom; existing 4-second gap and history-specific caps remain | Conservative application-side protection based on observed Cloudflare 1015; not FYERS's published quota |
| REST state | Cooldown, rolling request ledger and counters are process-local; startup requires one controlled interactive recovery probe | Restart-durable cooldown is not implemented; do not imply otherwise |
| WebSocket | One socket; desired, SDK-requested and pending subscription states; paced one-symbol batches at 1.2 seconds; generic ACK is not treated as symbol-level proof | SDK subscription restoration and live tick proof still need an NSE-session test |
| F&O master | Runtime diagnostics reported 94,071 FO rows, 10,222 CM rows, 93,404 active option contracts, 224 active underlyings, 218 mapped underlyings | Master mapping exists; it does not mean all 218 are subscribed or live |
| Scanner | 20 rotating socket slots, 8-symbol scan slice; scanner is gated by NSE session, fresh index feed and REST recovery state | Rolling observation only; never simultaneous 218-symbol live coverage |
| Strategy engine | Exactly nine IDs: EMA20/EMA50, Top Gainer breakout, daily-trend pullback, day high/low retest, double top/bottom neckline retest, bullish continuation, bearish continuation, flag/volume breakout, opening-range breakout | Ascending/descending triangle, pennant and flag are pattern variants inside continuation logic, not separate strategy IDs |
| Entry | Three contiguous completed option candles, live premium trigger, structural stop, chase guard and canonical risk-plan validation; RR floor 1:2 | Code-level fixtures exist; full CE/PE × nine-strategy matrix and live acceptance remain open |
| PWA | Versioned shell cache; API routes bypass service-worker cache; obsolete cache eviction and activation logic present | Browser-level update lifecycle proof remains open |
| Orders | `tradingEnabled()` returns false | Broker order placement remains disabled |

## Runtime evidence after PR #86 deploy

Observed in the post-deploy window:
- WebSocket connected and three index subscriptions were paced individually.
- NIFTY exchange tick age was approximately 23.8 million ms; BANK NIFTY approximately 4.0 million ms; SENSEX approximately 5.65 million ms. All were marked `fresh:false`.
- Official F&O master mapping reported 218 underlyings; active socket slots were 0.
- Scanner reported current-session master refresh pending before master diagnostics completed.
- No 1015/429 records appeared in the queried post-deploy log window. This is not proof of recovery: no successful Option Chain or Account Feed response was evidenced, and the market was closed.
- Render process startup and deploy success were confirmed; application-level trading readiness was not.

## Findings and closure requirements

### P0 — Live pipeline not proven
**Finding:** No fresh live index ticks, selected underlying tick, selected option tick, completed live option candles, or end-to-end Entry ledger were evidenced after deploy.
**Closure:** During NSE hours, capture exchange timestamps and receipt ages for all three indices, one selected F&O underlying and its exact CE/PE contract; verify contiguous completed candles; produce one complete positive or explicit rejection ledger. No trade unless every gate passes.

### P1 — Option Chain and Account Feed recovery unproven
**Finding:** PR #86 globally paces market/account requests routed through `src/fyers-rest.js`, but post-deploy logs did not prove successful Option Chain, positions or orderbook responses. OAuth code exchange in `src/fyers-auth.js` is a separate direct request path and is not part of the market/account REST scheduler budget.
**Closure:** Add explicit endpoint-level request/response telemetry and verify each path independently. Preserve source/path/priority/status/latency/CF-Ray diagnostics without logging secrets or tokens. Confirm account polling does not starve option/entry work.

### P1 — Restart-durable REST cooldown unavailable
**Finding:** REST cooldown and rolling-window history are process-local. A Render restart clears them; startup fail-closed probe reduces risk but does not restore the prior cooldown deadline.
**Closure:** Either implement a durable store that is available and verified within the no-paid-service constraint, or retain and clearly document process-local behavior with a conservative restart recovery policy. Do not claim durable cooldown until restart tests prove it.

### P1 — REST governor scope wording is broader than implementation
**Finding:** The 6/60s governor applies to requests routed through `fyers-rest.js`; the OAuth token exchange in `fyers-auth.js` is a direct fetch. Public symbol-master downloads use a separate public host and daily cache.
**Closure:** Keep the claim scoped to broker market/account REST requests, or deliberately integrate OAuth with a shared origin-level limiter after evaluating authentication failure and queue semantics.

### P1 — Health readiness is not full trade readiness
**Finding:** `/health` separates process liveness from market-pipeline blockers, but its `MARKET_DATA_READY` state does not prove Account Feed, selected-option candle continuity, a strategy confirmation, risk-plan validity, or an eligible setup.
**Closure:** Keep health as process/market-data readiness only. Add a separate explicit setup/entry readiness ledger with AUTH, REST, index, underlying, option, contract, candle, strategy, risk and account-feed states. Never let a generic `READY` label imply orders are enabled.

### P1 — F&O coverage semantics
**Finding:** 218 is the mapped universe; 20 is the rotating WebSocket slot count; 8 is the scan slice. These are different quantities. Rolling observations are not simultaneous and may age out.
**Closure:** UI and API must always expose universe count, current socket slice, scan slice, last observed time, fresh/stale/missing counts and rotation age. Selected symbol must remain pinned. Top Gainers must use only fresh current-session observations.

### P1 — Entry test matrix incomplete
**Finding:** Representative positive/negative tests exist for all nine strategy families and the CE option 3-candle path, but the documented full CE/PE × nine-strategy matrix, session-boundary matrix and exact risk-rounding matrix are not complete.
**Closure:** Add table-driven CE and PE fixtures for each strategy, invalid contract/expiry/tick/candle-gap/duplicate/stale/late premium cases, exact tick rounding, chase >0.5R rejection, RR 1.99 rejection, and explicit NO TRADE outputs.

### P2 — Strategy name/pattern expectation mismatch
**Finding:** The nine strategy IDs include `BULLISH_CONTINUATION` and `BEARISH_CONTINUATION`; ascending/descending triangles, pennants and flags are variants reported as pattern metadata. `FLAG_BREAKOUT_VOLUME` is another distinct ID.
**Closure:** Keep UI labels and user-facing documentation explicit about parent strategy vs pattern subtype. Add direct fixture tests for ascending triangle, descending triangle, pennant and flag subtypes.

### P2 — Frontend polling verification incomplete
**Finding:** Status polling has overlap protection and hidden-tab pause; account refresh is throttled to 120 seconds and universe refresh to 30 seconds. Full browser-level endpoint cadence, abort-on-symbol-change and rapid navigation tests remain open.
**Closure:** Add browser/fake-timer tests that assert bounded requests, no overlap, no background polling, and cancellation of obsolete chart/option requests.

### P2 — Documentation drift
**Finding:** README said Node.js 20+ while `package.json`, Render `NODE_VERSION`, and GitHub Actions specify Node 22. The older reliability register referenced PR #85 and the pre-PR #86 8/minute history-only policy.
**Closure:** README runtime statement corrected in this branch. Update the reliability register to reflect PR #86's global market/account REST governor and current deployment evidence before treating it as the current source of truth.

### P2 — Operational evidence / rollback
**Finding:** Deploy SHA and live event are verified, but a tested rollback/restore drill and a stable runtime evidence bundle are not recorded.
**Closure:** Maintain a release record with approved SHA, CI + Verify runs, Render deploy ID, health output, post-deploy endpoint checks, market-session proof and rollback reference.

## Required next phases

1. **REST endpoint proof:** Option Chain, positions, orderbook, chart and Entry request path; source/path/priority/response/latency; no 1015 recurrence under controlled cadence.
2. **WebSocket proof:** auth, reconnect, per-symbol ACK/tick identity, 3/3 fresh indices, selected underlying and selected option fresh ticks.
3. **Scanner proof:** official master current, rotation cadence, actual per-symbol scan ledger, fresh-only Top Gainers and measured 218-universe rolling coverage.
4. **Entry proof:** CE and PE, exact contract/expiry/strike/tick, three contiguous completed option candles, Entry/SL/Target/RR >= 2, no chase, explicit rejection reasons.
5. **UI/runtime proof:** account polling, no overlap, browser PWA update, no misleading ready state.
6. **Release proof:** CI and Verify pass, manual approval, deployed SHA confirmation, market-open acceptance, rollback record.

## Non-negotiable safety
- FYERS only; NSE only.
- No synthetic, sample, stale or unverified actionable data.
- Missing/stale/mismatched input means NO TRADE.
- Orders stay disabled.
- Auto-Deploy stays OFF; manual deploy only with explicit approval.
- No legacy service changes and no paid dependencies.
- This audit branch does not change production behavior.
