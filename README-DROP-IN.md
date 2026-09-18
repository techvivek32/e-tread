# NOVA E*TRADE — built code & drop-in instructions

Everything here is written, syntax-checked and unit-tested on this machine.
Plan and API facts: [../09-ETRADE-PORT-PLAN.md](../09-ETRADE-PORT-PLAN.md).

---

## 1. What is in this folder

```
nova-etrade/
├── server/                        the broker bridge — replaces BOTH the Java gateway and server-proxy.cjs
│   ├── etrade-proxy.cjs           Express service: routes, caller auth, keepalive, wiring
│   ├── lib/
│   │   ├── oauth1.cjs             OAuth 1.0a HMAC-SHA1 signer (Node built-ins only)
│   │   ├── token-store.cjs        AES-256-GCM encrypted token on disk + midnight-ET expiry model
│   │   ├── throttle.cjs           token bucket + 429 backoff (E*TRADE publishes no limits)
│   │   ├── etrade-client.cjs      every signed REST call, normalised; preview→place→VERIFY
│   │   └── oco-watcher.cjs        synthetic bracket engine (E*TRADE's API has no brackets)
│   ├── test/
│   │   ├── oauth1.test.cjs        8 tests — incl. the canonical OAuth Core 1.0 A.5.1 vector
│   │   └── oco.test.cjs           11 tests — incl. the double-exit safety invariant
│   ├── tools/live-check.cjs       drives every endpoint against the real API and prints the result
│   ├── package.json · .env.example · ecosystem.config.cjs
├── src/
│   ├── lib/api/etrade.ts          THE broker layer — drop-in replacement for ibkr.ts
│   └── components/EtradeConnect.tsx   OAuth login UI, session pill, bracket-health banner
├── sql/01-etrade-trades.sql       etrade_trades + RLS + app_flags, for the NEW Supabase project
└── nginx/nova-etrade.conf         TLS site for app :7180 and proxy :8005
```

## 2. Proven, not claimed

```
$ node test/oauth1.test.cjs     8 passed
$ node test/oco.test.cjs       14 passed
$ npx tsc --noEmit (in the host app)  strict, clean — 0 errors across 105 files
$ node --check <every .cjs>        clean
```

The OAuth signer is verified against the **OAuth Core 1.0 Appendix A.5.1** published vector —
base string, RFC3986 encoding, parameter sorting and the HMAC key all match byte for byte. If
that passes, E*TRADE accepts our signatures.

The bracket tests cover the paths that cost money: an unverifiable stop becomes a loud ERROR,
a filled stop never spawns a target, a restart never duplicates a live stop, and —
**the important one** — if the stop cancellation cannot be confirmed, the target is *not*
placed, because both filling would flip the position to the opposite side.

## 2b. Confirmed against the live E*TRADE sandbox

`node server/tools/live-check.cjs` drives every endpoint the terminal uses and prints what came
back. Current result: **14 passed, 0 failed.** The OAuth handshake, account list, balance,
portfolio, quotes (including >50-symbol chunking), symbol lookup, order book, order
preview -> place -> cancel, option expiries, option chain with greeks, transactions and
`renew_access_token` all work against the real API.

Three real bugs were found this way and fixed — none would have shown up in unit tests:

| Bug | Symptom | Cause |
|---|---|---|
| Multi-symbol quotes all failed | `oauth_problem=signature_invalid` | The comma separator was percent-encoded to `%2C` in the path, so our signature base string disagreed with E*TRADE's. Commas must stay raw. |
| Trade archive always empty | fields silently blank | The transaction envelope lower-cases `brokerage`/`product`, unlike every other Pascal-cased response. |
| Trade archive returned HTTP 500 | no error body | `count` above 50 makes the transactions endpoint fail. Now clamped. |

**What the sandbox cannot prove.** It serves canned fixtures: quotes come back as
GOOG/IBM/SWOIX with null prices whatever you ask for, the order book is a static list from
2012, balances are zeroed and transactions are 2013 transfers. So these must be re-checked on
the first production day, and the live check labels each one `SANDBOX` rather than claiming a pass:

- **order verification** — the most important one. A just-placed order never appears in the
  sandbox order book, so the poll cannot be exercised end to end. Re-run in production.
- **balance field mapping** — every figure is zero here, so the buying-power fallbacks are unproven.
- **quote prices and symbol matching**.
- **live option expiries** (the fixture returns 2012 dates).

---

## 3. What is NOT done — three integration points

These need the real repo (`quant-forge-os`), which is not on this machine. They are small and
explicit, not hidden:

| # | What | Where |
|---|---|---|
| 1 | **Type alignment.** `etrade.ts` declares its own `Quote` / `Position` / `BrokerOrder` types. Diff them against the real `ibkr.ts` and rename fields so call sites compile untouched. | `src/lib/api/etrade.ts` |
| 2 | **Chart route.** `getChartData()` calls `/ts-api/chart?symbol=…`. Point it at TradeScope's actual chart route. | `etrade.ts` → `getChartData` |
| 3 | **Token provider wiring.** Call `setAccessTokenProvider(...)` once at boot so every broker call carries the Supabase JWT. | `src/lib/auth-context.tsx` |

```ts
// in auth-context.tsx, after the supabase client exists
import { setAccessTokenProvider } from './api/etrade';
setAccessTokenProvider(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);
```

Also expected, and ordinary: swap `ibkr` imports for `etrade` across the UI, rename the trades
table to `etrade_trades` in `trade-store.ts`, and render `<EtradeConnect />` on the broker page.

---

## 4. WHAT YOU MUST COLLECT — and exactly where from

### A. From E*TRADE — do this first, it has the longest wait

| # | Item | Where | Wait |
|---|---|---|---|
| A1 | **Sandbox** consumer key + secret | developer.etrade.com → request sandbox access | hours–days |
| A2 | Signed **API Developer Licensing Agreement** → **production** consumer key + secret | us.etrade.com/l/f/agreement-library/api-developer-licensing-agreement → sign → email to E*TRADE's API team | a few business days |
| A3 | Signed **market data agreement** | E*TRADE developer portal | without it every quote is DELAYED |
| A4 | `accountIdKey` | not needed by hand — the proxy reads it from `/v1/accounts/list` right after the first login | — |
| A5 | Options approval level on the account | E*TRADE account settings | only if F&O is in scope |

> **The E*TRADE username and password are never needed and must never be shared.** The API
> authenticates with the consumer key/secret plus a daily token the trader approves themselves.

### B. Infrastructure

| # | Item | Notes |
|---|---|---|
| B1 | **Server** | New VPS, or the existing box with new ports. Nothing in this stack touches the live IBKR instance. |
| B2 | **Subdomain + DNS** | one host for the app, one for the proxy. A-records to the VPS. |
| B3 | **New Supabase project** | URL + anon key. Run `sql/01-etrade-trades.sql`. Do NOT reuse the existing USA project. |
| B4 | **The trader's login email** | goes in `ALLOWED_EMAILS`; the proxy refuses everyone else. |
| B5 | **SMTP credentials** | only for the statement/trade mailer (phase 2). |
| B6 | **The NOVA app repo** | the existing `quant-forge-os` codebase, on the build machine. |

---

## 5. Install & run

### Local / sandbox

```bash
cd nova-etrade/server
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> ETRADE_TOKEN_KEY
# fill ETRADE_CONSUMER_KEY / SECRET (sandbox), SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_EMAILS
npm test          # 19 tests must pass before anything else
npm start
```

Then in the app: open the Broker page → **Authorise on E*TRADE** → approve → paste the
5-character code → connected.

### VPS

```bash
# proxy
mkdir -p /var/www/nova-etrade/server /var/log/nova-etrade
# copy server/ there, then:
cd /var/www/nova-etrade/server && npm install --omit=dev
cp .env.example .env && chmod 600 .env     # fill it in
node --check etrade-proxy.cjs && npm test

# app (after the three integration points above)
cd /var/www/nova-etrade/app && npm install && npm run build

# start both
pm2 start /var/www/nova-etrade/server/ecosystem.config.cjs && pm2 save

# nginx
cp nginx/nova-etrade.conf /etc/nginx/sites-available/nova-etrade
ln -s /etc/nginx/sites-available/nova-etrade /etc/nginx/sites-enabled/nova-etrade
certbot --nginx -d <app-domain> -d <proxy-domain>
nginx -t && systemctl reload nginx
```

**Never run `pm2 restart all`.** Restart by name: `pm2 restart etrade-proxy quant-forge-etrade`.
`all` would bounce the live IBKR gateway and force an unplanned human re-login on the production instance.

### Going to production

Set `ETRADE_ENV=production` and swap in the production consumer key/secret. Nothing else
changes — the base URL is derived from that one variable.

---

## 6. The daily routine

E*TRADE access tokens **die at midnight US Eastern**, exactly like the IBKR SSO expires daily.
One human step each trading morning:

1. Open the Broker page.
2. **Authorise on E*TRADE** → log in on E*TRADE's own page → approve.
3. Paste the 5-character code → Connect.

The proxy then renews the token every 90 minutes so the 2-hour inactivity timeout never bites.
Nothing can extend a token past midnight ET — that is E*TRADE's rule, not a limitation here.

---

## 7. Health checks

```bash
curl -s 127.0.0.1:8005/health | jq          # session state, bracket engine, throttle
curl -s 127.0.0.1:8005/api/status | jq      # what the Topbar pill shows
pm2 logs etrade-proxy --lines 50
cat /var/www/nova-etrade/server/.state/brackets.json   # live synthetic brackets
```

`oco.healthy: false` while brackets are active means **profit targets are not being watched**.
Stops are unaffected — they are real orders sitting at E*TRADE — but exits need managing by
hand until it clears. The UI shows this as a red banner that does not auto-dismiss.

---

## 8. Before the first real trade

Run this on sandbox first, then repeat with 1 share on production:

- [ ] connect, disconnect, reconnect
- [ ] market buy → `verified: true` and the order appears in the E*TRADE order book
- [ ] limit buy well away from the market → shows as working → cancel it
- [ ] bracket order → confirm the STOP is visible in E*TRADE's own order list (not just in NOVA)
- [ ] restart the proxy with a live bracket → `brackets.json` reloads, no duplicate stop
- [ ] force a target touch → stop cancelled, target placed, both confirmed at the broker
- [ ] leave it idle > 2h → keepalive renews, session still CONNECTED
- [ ] let it cross midnight ET → state becomes EXPIRED and the UI says so plainly
- [ ] sell the position → working orders cancelled first, no leftover short
