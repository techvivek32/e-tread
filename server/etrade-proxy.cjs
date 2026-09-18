#!/usr/bin/env node
/**
 * NOVA E*TRADE proxy  —  the broker bridge.
 *
 * Replaces the IBKR pair (Java Client Portal Gateway :7175 + server-proxy.cjs :8002) with a
 * single Node service. E*TRADE is pure REST, so there is no gateway process to babysit:
 * no ssodh/init bridge, no Akamai header games, no "Address already in use" Java restarts.
 *
 * What it owns:
 *   - the OAuth 1.0a handshake (the one daily human step) and the encrypted token on disk
 *   - a keepalive that calls renew_access_token so the 2h inactivity timeout never bites
 *   - every signed call to E*TRADE, rate-limited and normalised
 *   - the synthetic bracket/OCO engine E*TRADE's API cannot provide
 *
 * SECURITY: this process can place real orders with real money. Every /api route except
 * /health and /api/status requires a valid Supabase JWT whose email is in ALLOWED_EMAILS.
 * It fails CLOSED — no ALLOWED_EMAILS, no access.
 *
 * Env: see .env.example
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { TokenStore } = require('./lib/token-store.cjs');
const { Throttle } = require('./lib/throttle.cjs');
const { EtradeClient, EtradeError } = require('./lib/etrade-client.cjs');
const { OcoWatcher } = require('./lib/oco-watcher.cjs');
const { getCandles } = require('./lib/chart.cjs');

// ------------------------------------------------------------------ configuration

const PORT = Number(process.env.PORT || 8005);
const ETRADE_ENV = (process.env.ETRADE_ENV || 'sandbox').toLowerCase(); // sandbox | production
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '.state');
const RENEW_INTERVAL_MS = Number(process.env.RENEW_INTERVAL_MS || 90 * 60 * 1000); // < 2h
const OCO_INTERVAL_MS = Number(process.env.OCO_INTERVAL_MS || 5000);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!ALLOWED_EMAILS.length) {
  console.error('FATAL: ALLOWED_EMAILS is empty. Refusing to start an open trading proxy.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_ANON_KEY required to verify callers.');
  process.exit(1);
}

const tokens = new TokenStore(path.join(STATE_DIR, 'etrade-token.enc.json'), process.env.ETRADE_TOKEN_KEY);
const throttle = new Throttle({
  rps: Number(process.env.ETRADE_RPS || 4),
  concurrency: Number(process.env.ETRADE_CONCURRENCY || 4),
});
const client = new EtradeClient({
  consumerKey: process.env.ETRADE_CONSUMER_KEY,
  consumerSecret: process.env.ETRADE_CONSUMER_SECRET,
  env: ETRADE_ENV,
  tokens,
  throttle,
});
const oco = new OcoWatcher({
  client,
  stateFile: path.join(STATE_DIR, 'brackets.json'),
  intervalMs: OCO_INTERVAL_MS,
});

/** The pending OAuth handshake lives in memory only — it is valid for minutes, not days. */
let pendingAuth = null;

// ----------------------------------------------------------------------- caller auth

const userCache = new Map(); // jwt -> { email, checkedAt }
const USER_CACHE_MS = 60 * 1000;

async function verifyCaller(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const jwt = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!jwt) return res.status(401).json({ error: 'missing bearer token' });

    const cached = userCache.get(jwt);
    if (cached && Date.now() - cached.checkedAt < USER_CACHE_MS) {
      req.userEmail = cached.email;
      return next();
    }

    const r = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!r.ok) return res.status(401).json({ error: 'invalid session' });

    const user = await r.json();
    const email = String(user?.email || '').toLowerCase();
    if (!email || !ALLOWED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'not authorised for this broker instance' });
    }

    userCache.set(jwt, { email, checkedAt: Date.now() });
    req.userEmail = email;
    return next();
  } catch (e) {
    return res.status(401).json({ error: `auth check failed: ${e.message}` });
  }
}

// ------------------------------------------------------------------------- app setup

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / server-to-server
      if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`origin not allowed: ${origin}`));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

/** Async route wrapper — turns EtradeError into a faithful HTTP status. */
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e instanceof EtradeError ? e.status || 502 : 500;
    console.error(`[proxy] ${req.method} ${req.path} -> ${status}:`, e.message);
    res.status(status).json({ error: e.message, code: e.code || null });
  });

const account = (req) => req.params.key || tokens.status().accountIdKey;

// ------------------------------------------------------------------------- routes

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'nova-etrade-proxy',
    etradeEnv: ETRADE_ENV,
    session: tokens.status().state,
    oco: oco.health(),
    throttle: throttle.stats(),
    uptimeSec: Math.floor(process.uptime()),
  });
});

/** Session state for the Topbar pill. Unauthenticated on purpose — it leaks nothing. */
app.get('/api/status', (_req, res) => {
  const s = tokens.status();
  res.json({
    state: s.state, // DISCONNECTED | EXPIRED | INACTIVE | CONNECTED
    etradeEnv: ETRADE_ENV,
    accountIdKey: s.accountIdKey || null,
    etDay: s.etDay || null,
    acquiredAt: s.acquiredAt || null,
    idleMs: s.idleMs ?? null,
    oco: oco.health(),
  });
});

// ---- OAuth: the one daily human step -------------------------------------------

app.post(
  '/api/auth/start',
  verifyCaller,
  wrap(async (_req, res) => {
    const started = await client.startAuth();
    pendingAuth = {
      requestToken: started.requestToken,
      requestTokenSecret: started.requestTokenSecret,
      startedAt: Date.now(),
    };
    res.json({ authorizeUrl: started.authorizeUrl });
  })
);

app.post(
  '/api/auth/complete',
  verifyCaller,
  wrap(async (req, res) => {
    const verifier = String(req.body?.verifier || '').trim();
    if (!verifier) return res.status(400).json({ error: 'verifier (the 5-character code) is required' });
    if (!pendingAuth) return res.status(409).json({ error: 'no pending authorization — start again' });

    const { token, tokenSecret } = await client.completeAuth({ ...pendingAuth, verifier });
    pendingAuth = null;
    tokens.set({ token, tokenSecret });

    // Adopt the account immediately so nothing downstream has to guess (multi-account model).
    const accounts = await client.listAccounts();
    const pinned = process.env.ETRADE_ACCOUNT_ID_KEY;
    const chosen = pinned
      ? accounts.find((a) => a.accountIdKey === pinned) || accounts[0]
      : accounts.find((a) => a.accountStatus === 'ACTIVE') || accounts[0];
    if (chosen) tokens.setAccountIdKey(chosen.accountIdKey);

    console.log(`[proxy] connected to E*TRADE (${ETRADE_ENV}) as account ${chosen?.accountId || 'unknown'}`);
    res.json({ ok: true, accounts, accountIdKey: chosen?.accountIdKey || null });
  })
);

app.post(
  '/api/auth/renew',
  verifyCaller,
  wrap(async (_req, res) => {
    await client.renew();
    res.json({ ok: true, state: tokens.status().state });
  })
);

app.post(
  '/api/auth/logout',
  verifyCaller,
  wrap(async (_req, res) => {
    await client.revoke();
    tokens.clear();
    res.json({ ok: true });
  })
);

// ---- accounts -------------------------------------------------------------------

app.get('/api/accounts', verifyCaller, wrap(async (_req, res) => res.json(await client.listAccounts())));

app.get(
  '/api/accounts/:key/balance',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.getBalance(account(req))))
);

app.get(
  '/api/accounts/:key/portfolio',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.getPortfolio(account(req))))
);

app.get(
  '/api/accounts/:key/transactions',
  verifyCaller,
  wrap(async (req, res) =>
    res.json(await client.getTransactions(account(req), { days: Number(req.query.days) || 6 }))
  )
);

// ---- orders ---------------------------------------------------------------------

app.get(
  '/api/accounts/:key/orders',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.listOrders(account(req), req.query)))
);

app.post(
  '/api/accounts/:key/orders/preview',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.previewOrder(account(req), req.body)))
);

/**
 * One-shot submit: preview -> place -> VERIFY, plus an optional bracket registration.
 *
 * Verification is not optional. The gateway-ACK-but-never-landed failure (gotcha #1) cost a
 * real exit once on IBKR; the same discipline applies to any broker.
 */
app.post(
  '/api/accounts/:key/orders/submit',
  verifyCaller,
  wrap(async (req, res) => {
    const key = account(req);
    const { bracket, ...spec } = req.body || {};

    const preview = await client.previewOrder(key, spec);
    const placed = await client.placeOrder(key, preview);

    if (!placed.orderId) {
      return res.status(502).json({
        error: 'E*TRADE accepted the request but returned no orderId — treat as NOT placed',
        preview: preview.messages,
        placed: placed.messages,
      });
    }

    const verification = await client.verifyOrderLive(key, placed.orderId);

    let registered = null;
    if (bracket && verification.verified) {
      registered = oco.register({
        accountIdKey: key,
        symbol: spec.symbol,
        securityType: spec.securityType || 'EQ',
        product: spec.securityType === 'OPTN' ? spec : null,
        quantity: spec.quantity,
        positionSide: /^(BUY|BUY_OPEN)$/.test(spec.action) ? 'LONG' : 'SHORT',
        entryOrderId: placed.orderId,
        stopPrice: bracket.stopPrice,
        trailingPercent: bracket.trailingPercent,
        targetPrice: bracket.targetPrice,
      });
    }

    res.json({
      orderId: placed.orderId,
      clientOrderId: placed.clientOrderId,
      verified: verification.verified,
      verifyAttempts: verification.attempts,
      order: verification.order,
      estimatedCommission: preview.estimatedCommission,
      estimatedTotalAmount: preview.estimatedTotalAmount,
      messages: [...preview.messages, ...placed.messages],
      bracket: registered,
      // The UI must shout about this one — a false "order placed" is the expensive failure.
      warning: verification.verified
        ? null
        : 'ORDER NOT FOUND IN THE BROKER ORDER BOOK AFTER SUBMIT — verify manually before re-placing',
    });
  })
);

app.put(
  '/api/accounts/:key/orders/cancel',
  verifyCaller,
  wrap(async (req, res) => {
    const orderId = req.body?.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    res.json(await client.cancelOrder(account(req), orderId));
  })
);

// ---- market data ----------------------------------------------------------------

app.get(
  '/api/market/quote',
  verifyCaller,
  wrap(async (req, res) => {
    const symbols = String(req.query.symbols || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!symbols.length) return res.status(400).json({ error: 'symbols required' });
    res.json(await client.getQuotes(symbols, { detailFlag: req.query.detailFlag || 'ALL' }));
  })
);

/**
 * Candles for the chart UI. E*TRADE has no history endpoint, so this serves consolidated-tape
 * data server-side. Display only — never the basis for an execution decision.
 */
app.get(
  '/api/market/chart',
  verifyCaller,
  wrap(async (req, res) => {
    const symbol = String(req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    res.json(await getCandles(symbol, req.query.period, req.query.bar));
  })
);

app.get(
  '/api/market/lookup/:q',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.lookup(req.params.q)))
);

app.get(
  '/api/market/optionexpiredates',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.optionExpireDates(req.query.symbol, req.query)))
);

app.get(
  '/api/market/optionchains',
  verifyCaller,
  wrap(async (req, res) => res.json(await client.optionChains(req.query.symbol, req.query)))
);

// ---- synthetic brackets ---------------------------------------------------------

app.get('/api/brackets', verifyCaller, (_req, res) => res.json({ health: oco.health(), brackets: oco.list() }));

app.post(
  '/api/brackets',
  verifyCaller,
  wrap(async (req, res) => {
    const b = req.body || {};
    // At least one leg must be asked for, otherwise there is nothing to manage.
    if (!b.symbol || !b.quantity || !b.positionSide) {
      return res.status(400).json({ error: 'symbol, quantity and positionSide are required' });
    }
    if (b.stopPrice == null && b.trailingPercent == null && b.targetPrice == null) {
      return res.status(400).json({ error: 'give at least one of stopPrice, trailingPercent or targetPrice' });
    }
    res.json(oco.register({ accountIdKey: b.accountIdKey || tokens.status().accountIdKey, ...b }));
  })
);

app.delete(
  '/api/brackets/:id',
  verifyCaller,
  wrap(async (req, res) => {
    const out = await oco.cancel(req.params.id);
    if (!out) return res.status(404).json({ error: 'bracket not found' });
    res.json(out);
  })
);

// -------------------------------------------------------------------------- keepalive

/**
 * E*TRADE kills an idle token after 2 hours. A normal trading day has gaps longer than that
 * (lunch, a quiet afternoon), so renew on a timer rather than hoping for traffic.
 * Nothing here can save a token past midnight ET — that needs the human.
 */
setInterval(async () => {
  const s = tokens.status();
  if (s.state === 'DISCONNECTED') return;
  if (s.state === 'EXPIRED') {
    console.warn('[keepalive] token expired at midnight ET — human re-authorization required');
    return;
  }
  try {
    await client.renew();
    console.log(`[keepalive] renewed (state=${tokens.status().state})`);
  } catch (e) {
    console.error('[keepalive] renew failed:', e.message);
  }
}, RENEW_INTERVAL_MS).unref?.();

// ------------------------------------------------------------------------------ boot

oco.start();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`nova-etrade-proxy listening on 127.0.0.1:${PORT}  (E*TRADE ${ETRADE_ENV})`);
  console.log(`  session: ${tokens.status().state}`);
  console.log(`  origins: ${ALLOWED_ORIGINS.join(', ') || '(any)'}`);
  console.log(`  allowed: ${ALLOWED_EMAILS.join(', ')}`);
});

process.on('SIGTERM', () => {
  oco.stop();
  tokens.persistNow();
  process.exit(0);
});
