# Reliability Audit Register — Historical Record

> **Superseded on 2026-11-23.** This file records the earlier PR #85 review state and must not be used as the current release/readiness status.

The current production deep audit, including PR #86's global market/account REST governor, Render deployment evidence, live-feed limitations, strategy/Entry gaps and required acceptance tests, is maintained in:

- [Deep Audit — 2026-11-23](./deep-audit-2026-11-23.md)

## Historical context

The earlier register was written against PR #85 before PR #86 introduced the 6-per-rolling-minute global market/account REST budget and the 3-per-minute background ceiling. Its references to an 8-per-minute history-only governor and four reserved history slots are historical and are not the current production policy.

Current safety invariants remain:
- FYERS only; NSE only.
- No synthetic, stale, cached-as-live or unverified actionable data.
- Missing or stale data means NO TRADE.
- All nine strategy IDs are retained.
- Completed candles and official FYERS contract identity are required.
- Minimum planned reward/risk is 1:2.
- Broker order placement remains disabled.
- Render Auto-Deploy remains OFF; manual deploy only with explicit approval.
- No legacy services or paid dependencies are to be introduced.

Do not mark the system production-trading-ready based on a successful Render deploy, process health, a connected WebSocket, or a loaded F&O master alone. The current audit's live-market acceptance gates must all pass first.
