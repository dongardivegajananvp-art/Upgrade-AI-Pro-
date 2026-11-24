# UPGRADE AI PRO — Reliability Audit Register
Date: 2026-11-24
Scope: NSE-only production workstation, Render service `upgrade-ai-pro`; main includes merged PRs #89, #90 and #91. Production remains on PR #86 deployment.

> This register supersedes the older PR #85-only audit. Do not use historical 8/minute history-only limits or four reserved history slots as current production policy.

## Current release state

- GitHub main: PR #89, #90 and #91 merged.
- Render: latest verified deploy `dep-dc22957f3r2c73e4evhg`, commit `6b8f86a3590bf41f792f6b0975a9d7f8d0125947` (PR #86); later merges are not deployed.
- Auto-Deploy: OFF; manual deploy only with explicit approval.
- Orders: disabled. Stale or unverified inputs => NO TRADE.
- Historical workflow: manual only, not run; no dataset or replay results exist.

## Reliability register

| ID | Area | Current code / merged change | Remaining proof / status |
|---|---|---|---|
| R1 | REST rate limiting and cooldown | PR #86 shared app-side market/account REST governor: 6 requests per rolling 60 seconds through `fyers-rest.js`; lower-priority work capped at 3/min; 4-second minimum gap and recovery controls. PR #89 adds encrypted browser-session cooldown restoration. | Not FYERS-published quotas. OAuth exchange and public master download are separate paths. Cookie is per browser session, not global/cross-device durable. Controlled 429/restart/recovery proof remains OPEN. |
| R2 | REST scheduling fairness | PR #89 adds fair Account/Scanner/Research scheduling, interactive-first Entry/Option Chain/Chart, queue expiry and identical authenticated GET coalescing only. | Verify every broker call site and endpoint response under controlled live-market load. POST is never coalesced. PARTIAL. |
| R3 | WebSocket lifecycle | PR #89 configures reconnect before connect and records bounded close-event details; desired/requested/pending state handling retained. | Production is still PR #86. Live reconnect, per-symbol tick freshness and duplicate-free subscription restoration remain unproven. PARTIAL. |
| R4 | F&O universe and coverage | Official master mapping; 20 rotating WebSocket slots; 218 mapped underlyings; PR #89 documents rolling coverage. | One history-backed underlying/minute implies >=218 minutes for ideal full pass. Prove rotation, selected-symbol pin, coverage age and fresh-only Top Gainers in NSE hours. PARTIAL. |
| R5 | Scanner and REST load | PR #89 adds pre-admission, retry retention and one history-backed underlying/minute. | Full-session coverage, queue latency and no starvation under live load remain unproven. PARTIAL. |
| R6 | Option contract identity | PR #89 adds official NSE contract gate across 9 strategy IDs × LONG/CE, LONG/PE, SHORT/PE, SHORT/CE. | Verify exact active expiry/underlying/side/strike/lot/tick and fresh option quote on live feed. PARTIAL. |
| R7 | Option candles and Entry confirmation | PR #89 adds nine-strategy positive setup fixtures and stale-option rejection plus negative invalidation matrix. | Live fresh option ticks, contiguous completed option candles and full CE/PE × nine-strategy acceptance remain OPEN. |
| R8 | Strategy data requirements | Nine strategy IDs retained; daily-history and Top Gainer-membership blockers are explicit. | Full live session/gap/duplicate/stale matrix remains open. Historical Top Gainer is not evaluated without timestamp-matched membership snapshots. PARTIAL. |
| R9 | Entry / SL / Target / RR | Canonical risk-plan and 1:2 minimum remain required by safety contract. | Independently verify exact Entry/SL/Target, tick rounding, chase guard and RR >=2 after rounding for each accepted setup. OPEN. |
| R10 | Frontend polling / PWA | PR #89 includes static regressions for cache versioning, API bypass, eviction, hidden-tab pause, overlap prevention and Account Feed single-flight. | Real-browser update lifecycle, endpoint cadence and abort-on-symbol-change proof remain open. PARTIAL. |
| R11 | Health and readiness truthfulness | PR #89 separates endpoint health from setup readiness and uses response-derived Option Chain/positions/orderbook status. | Production deployment and live endpoint successes not verified. Process health or OAuth connected must never imply trade readiness. PARTIAL. |
| R12 | Auth lifecycle | FYERS OAuth exchange was observed successful in the 2026-11-24 runtime window. | Feed freshness remains stale; auth success is not market readiness. Secret rotation/replay/expiry and live feed recovery still require evidence. PARTIAL. |
| R13 | Historical replay isolation | Manual GitHub-hosted workflow; offline worker has no live server/FYERS/WS/scanner/order imports; separate input/output; non-actionable results. PR #90 closes quiet-window race; PR #91 blocks incomplete manifests. | Workflow not run; secrets presence unverified; no dataset/artifact. Hashes are integrity checks, not FYERS signatures. Underlying signal replay only, not option fills/P&L. OPEN. |
| R14 | Runtime lifecycle | PR #89 includes bounded WebSocket close diagnostics and scanner admission controls. | Production deploy and live lifecycle/soak evidence remain pending. PARTIAL. |
| R15 | Release / rollback | Render Auto-Deploy OFF; deployment is manual. | PR #89–91 not deployed. Need CI + Verify, explicit approval, manual deploy, exact SHA confirmation, market-open acceptance and rollback drill. OPEN. |

## Mandatory release gates

- 3/3 fresh index ticks with exchange timestamps and receipt ages during NSE hours.
- Fresh selected F&O underlying and exact official option contract; verified quote and contiguous completed candles.
- Response-derived Option Chain, positions and orderbook success.
- Nine-strategy positive/negative CE/PE matrix with no weakened freshness or candle gates.
- Entry/SL/Target and RR >=1:2 verified after tick rounding; stale/missing/mismatched => NO TRADE.
- Rolling 218-symbol coverage reported honestly; no simultaneous-live claim.
- UI readiness distinguishes process, auth, market feed, setup and risk.
- Historical replay remains isolated, non-actionable, complete-manifest-only; no option P&L claims.
- CI + Verify, explicit approval, manual deployment, deployed SHA proof and rollback reference.

This register is a documentation status record, not a production release authorization. No deploy, secret change, historical workflow run or order enablement is authorized by this file.
