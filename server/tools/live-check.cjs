#!/usr/bin/env node
/**
 * Live connectivity check against E*TRADE.
 *
 * Run it after connecting the broker, and again on the day ETRADE_ENV flips to production.
 * It exercises every endpoint the terminal depends on and prints what came back, so a broken
 * field mapping shows up here rather than mid-trade.
 *
 *   node tools/live-check.cjs                 full check
 *   node tools/live-check.cjs --read-only     no order is placed (default in production)
 *   node tools/live-check.cjs --place-order   explicitly allow the order test in production
 *
 * ORDER TEST: placing an order is REAL in production. It is therefore skipped unless you pass
 * --place-order. When it runs it submits a 1-share AAPL buy at a limit of $1 — far enough
 * below any conceivable market that it cannot fill — and cancels it again immediately.
 *
 * SANDBOX HONESTY: E*TRADE's sandbox serves canned fixtures for several endpoints — quotes
 * come back as GOOG/IBM/SWOIX with null prices whatever you ask for, the order book is a
 * static list from 2012, balances are zeroed, transactions are 2013 transfers. Those are not
 * defects in this code and are labelled SANDBOX below. Anything needing real data to prove —
 * above all order verification — can only be proven in production.
 */

'use strict';

require('dotenv').config();
const path = require('path');
const { TokenStore } = require('../lib/token-store.cjs');
const { Throttle } = require('../lib/throttle.cjs');
const { EtradeClient } = require('../lib/etrade-client.cjs');

const STATE = process.env.STATE_DIR || path.join(__dirname, '..', '.state');
const SANDBOX = (process.env.ETRADE_ENV || 'sandbox').toLowerCase() !== 'production';
// Real money: never place an order in production unless it was asked for explicitly.
const PLACE_ORDER = process.argv.includes('--place-order') || (SANDBOX && !process.argv.includes('--read-only'));

const tokens = new TokenStore(path.join(STATE, 'etrade-token.enc.json'), process.env.ETRADE_TOKEN_KEY);
const client = new EtradeClient({
  consumerKey: process.env.ETRADE_CONSUMER_KEY,
  consumerSecret: process.env.ETRADE_CONSUMER_SECRET,
  env: SANDBOX ? 'sandbox' : 'production',
  tokens,
  throttle: new Throttle({ rps: 2, concurrency: 2 }),
});

let pass = 0;
let fail = 0;
const ok = (n, m) => { pass += 1; console.log(`  PASS      ${n}${m ? ' - ' + m : ''}`); };
const bad = (n, m) => { fail += 1; console.log(`  FAIL      ${n} - ${m}`); };
const note = (n, m) => console.log(`  SANDBOX   ${n} - ${m}`);
const detail = (m) => console.log(`            ${m}`);

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    bad(name, String(e.message).slice(0, 160));
  }
}

(async () => {
  const st = tokens.status();
  if (st.state === 'DISCONNECTED' || st.state === 'EXPIRED') {
    console.log(`\nNot connected (state=${st.state}). Authorise on the Broker page first.\n`);
    process.exit(1);
  }
  console.log(`\nE*TRADE live check - ${SANDBOX ? 'SANDBOX' : 'PRODUCTION'}\n`);

  let key = st.accountIdKey;

  await step('accounts', async () => {
    const a = await client.listAccounts();
    ok('list accounts', `${a.length} found`);
    a.forEach((x) => detail(`${x.accountId} | ${x.accountIdKey} | ${x.accountType} | ${x.accountStatus}`));
    key = key || a.find((x) => x.accountStatus === 'ACTIVE')?.accountIdKey || a[0]?.accountIdKey;
  });

  await step('balance', async () => {
    const b = await client.getBalance(key);
    ok('balance', `net=${b.netAccountValue} cash=${b.cash} buyingPower=${b.buyingPower}`);
    if (SANDBOX && !b.netAccountValue && !b.cash) {
      note('balance values', 'zeroed fixture - confirm this mapping on a funded production account');
    }
  });

  await step('portfolio', async () => {
    const p = await client.getPortfolio(key);
    ok('portfolio', `${p.length} positions`);
    p.slice(0, 5).forEach((x) =>
      detail(`${x.symbol} qty=${x.quantity} avg=${x.avgCost} last=${x.lastPrice} pnl=${x.unrealizedPnl}`));
  });

  await step('quotes', async () => {
    const want = ['AAPL', 'MSFT', 'NVDA'];
    const q = await client.getQuotes(want);
    ok('quotes', `${q.length} rows`);
    q.forEach((x) =>
      detail(`${x.symbol} last=${x.last} bid=${x.bid} ask=${x.ask} prev=${x.prevClose} status=${x.quoteStatus}`));
    const got = q.map((x) => x.symbol);
    if (SANDBOX && !want.every((s) => got.includes(s))) {
      note('quote symbols', `asked for ${want.join(',')} and got ${got.join(',')} - fixture substitution`);
    }
    if (q.some((x) => x.last == null)) {
      note('quote prices', 'null in the fixture; production returns real prices');
    }
  });

  await step('quote chunking', async () => {
    const pool = ['AAPL', 'MSFT', 'NVDA', 'GOOG', 'AMZN', 'META', 'TSLA', 'NFLX', 'AMD', 'INTC'];
    const many = Array.from({ length: 60 }, (_, i) => pool[i % 10]);
    const q = await client.getQuotes(many);
    ok('quote chunking', `60 symbols requested across chunks, ${q.length} rows back, no error`);
  });

  await step('symbol lookup', async () => {
    const s = await client.lookup('APPL');
    ok('symbol lookup', `${s.length} hits, first=${s[0]?.symbol}`);
  });

  await step('orders', async () => {
    const o = await client.listOrders(key, { count: 50 });
    ok('list orders', `${o.length} orders`);
    o.slice(0, 3).forEach((x) => detail(`${x.orderId} ${x.symbol} ${x.action} ${x.quantity} ${x.status}`));
  });

  let placedId = null;
  if (!PLACE_ORDER) {
    console.log('  SKIPPED   order placement - real money. Re-run with --place-order to test it.');
  }
  await step('order preview/place', async () => {
    if (!PLACE_ORDER) return;
    // A limit far below the market: it cannot fill, and it is cancelled again below.
    const spec = {
      symbol: 'AAPL',
      securityType: 'EQ',
      action: 'BUY',
      quantity: 1,
      priceType: 'LIMIT',
      limitPrice: 1,
      orderTerm: 'GOOD_UNTIL_CANCEL',
      marketSession: 'REGULAR',
    };
    const prev = await client.previewOrder(key, spec);
    ok('order preview', `previewId=${prev.previewIds[0]?.previewId} commission=${prev.estimatedCommission}`);
    prev.messages.forEach((m) => detail(`msg [${m.code}] ${m.description}`));
    const placed = await client.placeOrder(key, prev);
    ok('order place', `orderId=${placed.orderId}`);
    placedId = placed.orderId;
  });

  if (placedId) {
    await step('order verification', async () => {
      const v = await client.verifyOrderLive(key, placedId, { attempts: 4, delayMs: 1200 });
      if (v.verified) {
        ok('order VERIFIED in the broker book', `status=${v.order.status}`);
      } else if (SANDBOX) {
        note(
          'order verification',
          'the sandbox order book is a static fixture, so a just-placed order never appears - this MUST be re-run in production'
        );
      } else {
        bad('order verification', 'placed order never appeared in the broker order book');
      }
    });

    await step('order cancel', async () => {
      await client.cancelOrder(key, placedId);
      ok('order cancel', `orderId=${placedId}`);
    });
  }

  await step('options', async () => {
    const exp = await client.optionExpireDates('AAPL');
    ok('option expiries', `${exp.length} dates, first=${exp[0]?.year}-${exp[0]?.month}-${exp[0]?.day}`);
    if (exp[0] && exp[0].year < 2020) {
      note('option expiries', 'fixture dates are historical; production returns live expiries');
    }
    if (exp[0]) {
      const ch = await client.optionChains('AAPL', {
        expiryYear: exp[0].year,
        expiryMonth: exp[0].month,
        expiryDay: exp[0].day,
        noOfStrikes: 4,
      });
      ok('option chain', `${ch.length} pairs`);
      const c = ch[0]?.call;
      if (c) {
        detail(
          `strike=${c.strikePrice} bid=${c.bid} ask=${c.ask} last=${c.lastPrice} ` +
            `vol=${c.volume} OI=${c.openInterest} iv=${c.OptionGreeks?.iv} delta=${c.OptionGreeks?.delta}`
        );
      }
    }
  });

  await step('transactions', async () => {
    const tx = await client.getTransactions(key, { days: 30 });
    ok('transactions', `${tx.length} rows`);
    tx.slice(0, 3).forEach((x) =>
      detail(
        `${x.transactionDate ? new Date(x.transactionDate).toISOString().slice(0, 10) : '?'} ` +
          `${x.transactionType} ${x.symbol || '-'} qty=${x.quantity} px=${x.price} fee=${x.commission}`
      ));
  });

  await step('keepalive', async () => {
    await client.renew();
    ok('renew_access_token', `state=${tokens.status().state}`);
  });

  console.log(`\n  ${pass} passed, ${fail} failed${SANDBOX ? '  (SANDBOX lines are fixture limits, not defects)' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('\n  ABORTED:', e.message);
  process.exit(1);
});
