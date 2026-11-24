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
- Active FYERS REST cooldown deadlines are now encrypted into an HttpOnly, Secure, SameSite=Lax browser-session cookie and restored before authenticated API work after a Render restart. This is a no-cost, browser-session-scoped persistence layer; it is not shared across separate browsers/devices, and a response lost before cookie delivery cannot persist its cooldown. The startup recovery probe remains required and is blocked until any restored deadline expires.
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
- [x] Added full-pipeline per-strategy negative E2E fixtures for EMA alignment, Top Gainer breakout, daily pullback touch/resume, day high/low retest, double-pattern neckline retest, bullish/bearish continuation impulse, flag volume contraction/breakout and opening-range breakout. Each evaluates `evaluateNineStrategies()` and asserts NO_TRADE, no selected strategy, no risk plan, and a specific ledger rejection reason. Separate full-pipeline cases cover missing daily history and missing verified Top Gainer membership.
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
| Strategy engine | Nine strategy IDs, positive end-to-end fixtures, full-pipeline strategy-specific negative E2E matrix, directional CE/PE mapping, contract identity and fixed-risk RR >= 1:2 | PASS for covered fixtures; live-market behavior remains unverified |
| FYERS REST | Fair scheduling, interactive priority, request coalescing, queue expiry, rolling budget/cooldown and endpoint response diagnostics have regression coverage | PASS in automated tests; not a live FYERS quota guarantee |
| WebSocket candles | Active-slice bounded 5m OHLC observations, gap/out-of-order/off-session handling and completed-bar boundaries | Diagnostic-only; volume is unverified and observations are not actionable |
| Scanner | Honest one-history-backed-underlying/minute cadence and 20-slot WebSocket rotation | Code-level checks only; full-session throughput/coverage not proven |
| Account Feed / Option Chain | Endpoint-specific health is tied to actual responses | Live response recovery still needs post-release market evidence |
| PWA / polling | Static tests cover versioned cache, API/cross-origin bypass, cache eviction, hidden-tab pause and request overlap/single-flight controls | Static regression only; real browser update/cache lifecycle remains open |
| Restart / rollback | Process-local cooldown limitation documented; rollback procedure documented | Restart-safe cooldown and an executed rollback drill remain open |

Compatibility is therefore **partially verified, not universally certified**. CI passing does not prove browser, broker, market-session, deployment, or restart behavior. No production deployment or Render configuration was changed by this PR.


### Full-pipeline strategy negative E2E increment

- Added `src/strategy-engine-negative-e2e.test.js` with strategy-specific invalidation scenarios executed through `evaluateNineStrategies()`, not just direct detector calls.
- The matrix covers all nine strategy IDs and asserts NO_TRADE, no selected strategy, no Entry/SL/Target/RR/contract output, and an explicit per-strategy ledger reason.
- Additional full-pipeline cases verify missing verified Top Gainer membership and missing daily history fail closed as BLOCKED.
- CI run #234 and Verify run #553 completed successfully on PR #89's merge ref for commit `a87e6431312ea04ca017c56c426984215b5cfb8e`: 261 tests passed, 0 failed. Production dependency audit and syntax checks also passed.
- This closes the automated full-pipeline negative fixture item for the covered conditions. It does not replace live-market acceptance or guarantee all possible market-data combinations.


## 2026-11-24 live-session evidence (production, unchanged deployment)

- Render process started at 2026-11-24T05:07:22Z and listened at 05:07:24Z. FYERS OAuth token exchange succeeded at 05:07:59Z.
- Official FYERS/NSE master loaded for 2026-11-24: 87,577 FO rows, 10,210 CM rows, 86,908 active option contracts, 224 active underlyings, and 218 mapped equity underlyings.
- The active WebSocket F&O slice remained at 0 because none of the three subscribed index ticks passed exchange-time freshness. The received NIFTY, BANK NIFTY and SENSEX ticks carried 2026-11-23 exchange timestamps and were explicitly marked `fresh:false`.
- The Data Socket repeatedly closed and auto-reconnected during the inspected window. The prior close callback discarded close-event details; PR #89 now captures bounded close details and configures SDK auto-reconnect before opening the transport.
- With no fresh index feed, F&O subscriptions, selected option ticks, and the live scanner correctly remained gated. No live strategy/Entry acceptance can be claimed from this window.
- Account positions, orderbook and Option Chain had no verified successful upstream response in this log window. Absence of a logged request is not evidence of recovery.
- Production remained on deployment `dep-dc22957f3r2c73e4evhg`; no PR #89 code was deployed. Orders remained disabled and stale/missing data remained NO TRADE.


## 2026-11-24 OAuth and socket log interpretation (production, unchanged deployment)

- At 2026-11-24T05:07:36Z the OAuth login route was reached and the configured redirect matched the expected production callback URI.
- At 2026-11-24T05:07:59Z the callback route was reached and the FYERS token exchange succeeded. This proves one successful OAuth callback in the inspected window.
- A second callback reached the route at 2026-11-24T05:10:04Z and was rejected as missing, mismatched, or already consumed state. No new login-route event was present immediately before this second callback in the inspected log window. This is consistent with a stale/duplicate callback after the successful login; it is not sufficient evidence that a fresh Connect attempt failed. A fresh single-click login-to-callback browser test is still required.
- The production socket emitted repeated close events at approximately two-minute intervals and reconnected about five to six seconds later. The deployed close handler logged no close-event payload, so the upstream close cause cannot be identified from these logs. PR #89 adds bounded close-detail capture, but this diagnostic change is not deployed.
- The socket received index messages immediately after connecting, but their exchange timestamps were from 2026-11-23 and were 18–24 hours old in the inspected window. Since 2026-11-24 was an NSE holiday, those messages are expected to fail the live freshness gate. They must not be treated as fresh market ticks.
- No code or production configuration was changed as part of this log review. OAuth fresh-flow validation, socket close-cause attribution, and next-open-session feed acceptance remain release gates.
