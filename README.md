# e-tread — E*TRADE broker layer for a NOVA-style trading terminal

A production broker bridge for the **E*TRADE Developer API**: OAuth 1.0a, order
`preview → place → verify`, and a synthetic bracket engine that supplies the OCO behaviour
E*TRADE's API does not offer.

Written to drop into an existing React/TanStack trading terminal that already talks to a broker
through a single API module — the UI keeps calling the same function names, and only the module
underneath changes.

---

## Why this exists

E*TRADE's REST API is capable but has three sharp edges that a trading UI has to absorb:

| Edge | What this repo does about it |
|---|---|
| **No bracket or contingent orders** (`"bracketed orders are not supported in API currently"`) | A watcher places a **real broker-held GTC stop** and manages the target itself. If the server dies, the stop survives. |
| **Access tokens die at midnight US Eastern**, and go inactive after 2h idle | An encrypted token store models both, and a keepalive calls `renew_access_token` every ~90 min. Midnight expiry is surfaced to the user as a plain "sign in again". |
| **No streaming quotes; no published rate limits** | Batched REST quotes (25/call, 50 with `overrideSymbolCount`) behind a token-bucket throttle with 429 backoff. |

It also carries over a hard-won rule from a live IBKR deployment: **an order acknowledgement is
not proof the order exists.** Every submit is followed by a poll of the broker's own order book,
and a verification failure is reported loudly rather than swallowed.

---

## Layout

```
server/                  the broker bridge (Node, no framework beyond Express)
  etrade-proxy.cjs       routes, caller authorisation, keepalive, wiring
  lib/
    oauth1.cjs           OAuth 1.0a HMAC-SHA1 signer — Node built-ins only
    token-store.cjs      AES-256-GCM token at rest + midnight-ET expiry model
    throttle.cjs         token bucket + exponential 429 backoff
    etrade-client.cjs    every signed REST call, envelopes unwrapped and normalised
    oco-watcher.cjs      synthetic bracket engine, persisted and crash-safe
  test/                  19 tests, no network required
src/
  lib/api/etrade.ts      the broker layer the UI imports
  components/EtradeConnect.tsx   OAuth connect screen, session pill, bracket-health banner
sql/                     trade archive + row-level security
nginx/                   TLS site template for the app and the proxy
```

## Tests

```bash
cd server && npm install && npm test
```

```
OAuth 1.0a signer          8 passed
Synthetic bracket engine  11 passed
```

The signer is checked against the published **OAuth Core 1.0 Appendix A.5.1** vector — base
string, RFC3986 encoding, parameter ordering and HMAC key construction all match exactly.

The bracket tests cover the paths that cost money, including the important one: **if a stop's
cancellation cannot be confirmed, the target is not placed**, because both filling would flip
the position to the opposite side.

## Security posture

- The E*TRADE account **username and password are never used**. Authentication is the consumer
  key/secret plus a daily token the account holder approves on E*TRADE's own site.
- The daily token is encrypted at rest (AES-256-GCM) under a key held only in the environment.
- The proxy **fails closed**: with no `ALLOWED_EMAILS` configured it refuses to start, and every
  trading route requires a valid, allow-listed Supabase JWT.
- The proxy binds to `127.0.0.1` and is reached only through the TLS vhost.
- No secrets in this repository — see `server/.env.example`.

## Getting started

Read [`README-DROP-IN.md`](README-DROP-IN.md): what to obtain from E*TRADE, how to configure,
how to deploy, and the pre-flight checklist to run before the first real order.

## Status

The bridge, the broker layer and the connect screen are written and tested. Integration with a
specific terminal codebase (type alignment, import swap, chart route) and end-to-end testing
against E*TRADE's sandbox are the remaining steps.
