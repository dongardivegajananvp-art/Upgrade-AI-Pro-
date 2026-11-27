# FYERS automatic access-token refresh

## Configuration

Add `FYERS_PIN` to the **production Render service environment** as a secret. Do not commit it, put it in GitHub source, or send it in chat. The app reads it only on the server.

The first successful OAuth login stores the FYERS refresh token in a separate AES-256-GCM encrypted, HttpOnly, Secure, SameSite=Lax cookie. The refresh cookie is bound to the configured FYERS App ID and secret and is never readable by browser JavaScript. The access-token cookie remains separately encrypted and expires at the daily FYERS 06:30 IST boundary.

## Refresh behavior

- While the Render process is awake and an authenticated session has been established, a server-side monitor checks token status once per minute and attempts refresh only inside the five-minute expiry window.
- If Render restarts, the next request from the browser can restore the encrypted refresh cookie and renew the access token. The refreshed access-token cookie is then issued automatically.
- Refresh attempts are single-flight and failures are backed off for five minutes. Tokens and PIN are never logged.
- If the refresh token is absent/expired, the PIN is missing, or FYERS rejects the refresh request, the app fails closed and requires a fresh OAuth Connect. It never treats the market feed as authenticated based only on process liveness.
- Broker order placement remains disabled.

## Provider compatibility limitation

The current public FYERS individual-app authentication reference documents daily access-token expiry and the authorization-code exchange, but does not currently document the `validate-refresh-token` endpoint. The implementation uses the known FYERS v3 refresh request shape (`grant_type=refresh_token`, `appIdHash`, `refresh_token`, `pin`) as a guarded compatibility path. Its availability must be confirmed by a real FYERS response in production; a successful unit test against a mocked response is not proof that FYERS currently accepts it.

The refresh credential is locally limited to 15 days. If FYERS changes or disables this endpoint, the app reports the failure and falls back to OAuth Connect rather than claiming continuous authentication.

## Availability boundary

The refresh token is held in the user's encrypted browser cookie, not in a durable server database. This avoids introducing a paid database, but it means a cold Render restart cannot recover the token until a browser request presents that cookie. Render Free keepalive pings do not carry the user's cookie and cannot independently restore broker authentication. A fully unattended cross-restart credential vault would require a separately approved durable secret store.
