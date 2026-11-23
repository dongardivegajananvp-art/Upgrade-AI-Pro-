# Reliability acceptance register — 2026-11-23

## Phase 1: REST scheduler controls (implemented on PR #89; not deployed)

- [x] Background Account, Scanner and Research classes receive fair service within the existing three-request/minute background budget.
- [x] Interactive Entry, Option Chain and Chart priorities remain ahead of background work.
- [x] Expired queued requests are rejected before upstream submission. Entry and Scanner have a 10-second queue age; Option Chain 15 seconds; Chart and Account 30 seconds; research/warmup 120 seconds.
- [x] Identical pending and in-flight requests are coalesced by HTTP method + full request URL.
- [x] Option Chain, positions and orderbook diagnostics are based on actual HTTP and FYERS API responses, not socket/auth status.
- [x] Health output separates process liveness, Account Feed, Option Chain, market-pipeline readiness and setup evaluation readiness.
- [x] History-backed scanner cadence is reduced to one new underlying per minute so its advertised batch matches the guarded REST budget. The 20-symbol socket slice continues to rotate with overlap.

## Constraints and explicit non-claims

- The 6/minute total and 3/minute background caps are conservative application guards based on observed Cloudflare 1015 behavior; they are not published FYERS quotas.
- Scanner cadence of one symbol/minute means a 218-symbol history-backed pass takes approximately 218 minutes if every request is admitted and every underlying has a fresh tick. Queue expiry, cooldown, missing ticks and account/research work can extend that time. It is not a simultaneous 218-symbol live scan.
- Cooldown timestamps remain process-local. Startup requires one interactive recovery probe before background work resumes; the exact pre-restart cooldown cannot be durably restored without a persistent store. No paid external storage has been introduced.
- Endpoint health remains NOT_VERIFIED until that endpoint has returned an actual response in the current process. A successful historical response is not proof of current market freshness.
- No market-live acceptance is claimed while NSE is closed.

## Still required before production release

- [ ] Live-market proof for NIFTY, BANK NIFTY and SENSEX exchange timestamps.
- [ ] Live selected F&O underlying and selected CE/PE option ticks.
- [ ] Account positions + orderbook and Option Chain successful response evidence after deployment.
- [ ] Scanner coverage/latency measurement over a full NSE session. WebSocket OHLC observations currently remain diagnostic-only; they do not yet replace the 5-minute REST history, daily/15-minute context, or verified volume required by strategy confirmation.
- [x] Positive end-to-end setup fixtures cover all nine strategy IDs with directional CE/PE contract validation and fixed Entry/SL/Target at RR >= 1:2.
- [x] A stale-option-quote negative end-to-end gate is exercised for all nine strategy IDs; Top Gainer also covers absent option tick, wrong CE/PE side, incomplete option candles, below-trigger wait and >0.5R chase rejection.
- [x] Added a nine-strategy evaluator-pipeline negative matrix using fresh underlying ticks, contiguous completed 5-minute candles and fresh daily context; every strategy must return an explicit REJECTED ledger reason when its pattern is absent.
- [x] Added targeted detector-level invalidation checks for EMA alignment, Top Gainer membership/breakout, missing daily pullback context, day-range retest, double-pattern structure, bullish/bearish continuation impulse, flag volume contraction and opening-range breakout. These are direct detector regressions; they are not yet independent full-pipeline E2E negative fixtures for each strategy.
- [ ] PWA browser update/cache lifecycle verification on real supported browsers.
- [ ] Manual rollback drill with Render deployment evidence.
- [ ] Final market-live acceptance; otherwise UI must remain NO TRADE and orders disabled.

## Rollback drill (documented procedure; not yet executed)

1. Keep Render Auto-Deploy OFF. Record the currently live deployment ID and the previous known-good live deployment ID before any release.
2. If post-deploy health or market-data acceptance fails, use the Render service's deployment history to redeploy the previous known-good deployment. Do not change environment variables as an improvised rollback.
3. Wait for Render to report the rollback deployment as live / succeeded.
4. Verify the production URL, /health, /api/status, OAuth session, WebSocket connection state, endpoint response diagnostics, and that Orders remain DISABLED.
5. Confirm stale/missing exchange data still results in NO TRADE.
6. Record rollback deployment ID, source deployment ID, timestamps, health response, and relevant redacted logs.
7. This drill must be performed in a controlled maintenance window with explicit user approval. Documentation alone is not rollback proof.

## Compatibility verification matrix (PR #89; source branch only, not production)

| Area | Verification performed | Status / boundary |
|---|---|---|
| Runtime baseline | CI and Verify install/use Node.js 22; JavaScript syntax checks and production dependency audits pass | PASS for the tested CI environment |
| Strategy engine | Nine strategy IDs, positive end-to-end fixtures, directional CE/PE mapping, contract identity and fixed-risk RR >= 1:2 | PASS for covered fixtures; full negative pattern matrix remains open |
| FYERS REST | Fair scheduling, interactive priority, request coalescing, queue expiry, rolling budget/cooldown and endpoint response diagnostics have regression coverage | PASS in automated tests; not a live FYERS quota guarantee |
| WebSocket candles | Active-slice bounded 5m OHLC observations, gap/out-of-order/off-session handling and completed-bar boundaries | Diagnostic-only; volume is unverified and observations are not actionable |
| Scanner | Honest one-history-backed-underlying/minute cadence and 20-slot WebSocket rotation | Code-level checks only; full-session throughput/coverage not proven |
| Account Feed / Option Chain | Endpoint-specific health is tied to actual responses | Live response recovery still needs post-release market evidence |
| PWA / polling | Static tests cover versioned cache, API/cross-origin bypass, cache eviction, hidden-tab pause and request overlap/single-flight controls | Static regression only; real browser update/cache lifecycle remains open |
| Restart / rollback | Process-local cooldown limitation documented; rollback procedure documented | Restart-safe cooldown and an executed rollback drill remain open |

Compatibility is therefore **partially verified, not universally certified**. CI passing does not prove browser, broker, market-session, deployment, or restart behavior. No production deployment or Render configuration was changed by this PR.


### Latest strategy negative-matrix increment

- A single full evaluator-pipeline negative fixture now checks all nine strategy ledger rows on a fresh, contiguous, pattern-neutral session and requires REJECTED plus a non-empty reason for every strategy.
- This complements the existing positive fixture for each strategy and stale-option-quote rejection for all nine.
- This does not close the remaining pattern-specific negative variants listed above.


### Targeted detector invalidation increment

- Direct negative tests now exercise the specific missing prerequisite for each strategy family, including both continuation directions.
- These complement the full evaluator neutral-session matrix and the all-nine stale-option quote gate.
- Full-pipeline pattern-specific negative E2E variants remain a separate acceptance item; no claim is made that detector tests alone prove every end-to-end rejection path.
