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
- [ ] Full nine-strategy CE/PE positive/negative matrix, including completed-candle continuity, expiry/strike identity, stale ticks and fixed Entry/SL/Target with RR >= 1:2.
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