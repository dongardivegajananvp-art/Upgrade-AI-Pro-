# Upgrade AI Pro

Independent NSE-only live trading workstation. No MCX code, routes, symbols, caches, UI, or persisted state are included.

## Safety contract

- FYERS is the only market-data and broker source.
- No synthetic, demo, stale, or cached-as-live actionable data.
- Freshness requires a verified exchange timestamp and bounded receipt age.
- Scanner output remains NO TRADE until underlying and option quotes, contract identity, completed candles, and risk checks are verified.
- Minimum planned reward/risk: 1:2.
- Broker order placement is disabled during build and initial verification.
- NSE regular session: 09:15–15:30 Asia/Kolkata.
- Rotating WebSocket coverage must never be described as simultaneous full-universe coverage.

## Local development

Node.js 20+; run `npm test` and `npm start`.

This repository is a clean foundation. It is not production-live until FYERS authentication, WebSocket freshness, scanner correctness, and end-to-end verification pass.
