/**
 * Synthetic bracket engine verification.
 *
 * Run: node test/oco.test.cjs
 *
 * These tests drive the watcher with a fake E*TRADE client so the dangerous paths are exercised
 * without a broker. The three that matter most:
 *   - the protective stop is a REAL broker order, placed and verified
 *   - the target is NEVER placed unless the stop cancellation is confirmed (a double exit
 *     would flip the position to the opposite side)
 *   - a missing quote produces NO action at all
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OcoWatcher, STATES } = require('../lib/oco-watcher.cjs');
const { EtradeClient } = require('../lib/etrade-client.cjs');

/** The real payload builder, so these tests exercise the actual E*TRADE order shape. */
const buildOrder = (spec) => EtradeClient.prototype.buildOrder.call(null, spec);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oco-')), 'brackets.json');
}

/** Minimal stand-in for EtradeClient. */
function fakeClient(opts = {}) {
  const c = {
    orders: opts.orders || [],
    quotes: opts.quotes || {},
    placed: [],
    cancelled: [],
    failVerify: !!opts.failVerify,
    cancelIsIgnored: !!opts.cancelIsIgnored,

    async listOrders() {
      if (opts.listThrows) throw new Error('order book unavailable');
      return c.orders;
    },
    async getQuotes(symbols) {
      return symbols.filter((s) => c.quotes[s] != null).map((s) => ({ symbol: s, last: c.quotes[s] }));
    },
    async previewOrder(_key, spec) {
      const { orderType, order } = buildOrder(spec);
      return { clientOrderId: 'CID', orderType, order, previewIds: [{ previewId: 1 }], messages: [] };
    },
    async placeOrder(_key, preview) {
      const orderId = String(1000 + c.placed.length);
      c.placed.push({ orderId, spec: preview.order });
      if (!c.failVerify) {
        c.orders.push({
          orderId,
          status: 'OPEN',
          symbol: preview.order.Instrument[0].Product.symbol,
          priceType: preview.order.priceType,
        });
      }
      return { orderId, clientOrderId: 'CID', messages: [] };
    },
    async cancelOrder(_key, orderId) {
      c.cancelled.push(String(orderId));
      if (!c.cancelIsIgnored) c.orders = c.orders.filter((o) => String(o.orderId) !== String(orderId));
      return { orderId };
    },
    async verifyOrderLive(_key, orderId) {
      const found = c.orders.find((o) => String(o.orderId) === String(orderId));
      return { verified: !!found, order: found || null, attempts: 1 };
    },
  };
  return c;
}

const LONG = {
  accountIdKey: 'ACC',
  symbol: 'AAPL',
  quantity: 10,
  positionSide: 'LONG',
  stopPrice: 95,
  targetPrice: 110,
};

(async function run() {
  console.log('\nSynthetic bracket engine');

  await check('entry fill arms the bracket and places a REAL broker-held stop', async () => {
    const client = fakeClient({ orders: [{ orderId: '1', status: 'EXECUTED', symbol: 'AAPL' }], quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: '1' });

    await w.tick(); // PENDING_ENTRY -> ARMED
    assert.strictEqual(w.brackets.get(b.id).state, STATES.ARMED);

    await w.tick(); // places the stop
    const after = w.brackets.get(b.id);
    assert.ok(after.stopOrderId, 'stop order id must be recorded');
    assert.strictEqual(client.placed.length, 1);
    assert.strictEqual(client.placed[0].spec.priceType, 'STOP', 'the stop must be a real STOP order');
    assert.strictEqual(client.placed[0].spec.orderTerm, 'GOOD_UNTIL_CANCEL', 'stop must be GTC');
    assert.strictEqual(client.placed[0].spec.Instrument[0].orderAction, 'SELL', 'long -> SELL to exit');
  });

  await check('an unverifiable stop is an ERROR, not a silent success', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 }, failVerify: true });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: null });

    await w.tick();
    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.ERROR);
    assert.match(after.note, /UNPROTECTED/);
  });

  await check('a filled stop closes the bracket and never places a target', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: null });

    await w.tick(); // arms + places stop
    const stopId = w.brackets.get(b.id).stopOrderId;
    client.orders = client.orders.map((o) => (o.orderId === stopId ? { ...o, status: 'EXECUTED' } : o));

    await w.tick();
    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.DONE);
    assert.strictEqual(after.note, 'stopped out');
    assert.strictEqual(client.placed.length, 1, 'only the stop was ever placed');
  });

  await check('target touched: stop cancelled first, then the target placed and verified', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: null });

    await w.tick(); // stop live
    const stopId = w.brackets.get(b.id).stopOrderId;

    client.quotes.AAPL = 111; // above the 110 target
    await w.tick();

    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.TARGET_PLACED);
    assert.ok(client.cancelled.includes(stopId), 'the stop must be cancelled');
    assert.strictEqual(after.stopOrderId, null, 'no stale stop id may linger');
    const target = client.placed[1];
    assert.strictEqual(target.spec.priceType, 'LIMIT');
    assert.strictEqual(Number(target.spec.limitPrice), 110);
  });

  await check('SAFETY: unconfirmed stop cancellation blocks the target entirely', async () => {
    // The broker acknowledges the cancel but the order stays OPEN in the book.
    const client = fakeClient({ quotes: { AAPL: 100 }, cancelIsIgnored: true });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: null });

    await w.tick(); // stop live
    client.quotes.AAPL = 120;
    await w.tick();

    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.ERROR);
    assert.match(after.note, /could not confirm stop cancellation/);
    assert.strictEqual(client.placed.length, 1, 'the target must NOT have been placed');
  });

  await check('no quote means no decision', async () => {
    const client = fakeClient({ quotes: {} }); // feed is down
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: null });

    await w.tick(); // stop still gets placed — that is protective, not speculative
    await w.tick();
    await w.tick();

    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.ARMED, 'must stay armed, never guess');
    assert.strictEqual(client.placed.length, 1, 'no target without a price');
  });

  await check('SHORT positions exit with BUY_TO_COVER', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    w.register({ ...LONG, positionSide: 'SHORT', stopPrice: 105, targetPrice: 90, entryOrderId: null });

    await w.tick();
    assert.strictEqual(client.placed[0].spec.Instrument[0].orderAction, 'BUY_TO_COVER');
  });

  await check('SHORT target triggers when price falls to it', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, positionSide: 'SHORT', stopPrice: 105, targetPrice: 90, entryOrderId: null });

    await w.tick();
    client.quotes.AAPL = 89;
    await w.tick();
    assert.strictEqual(w.brackets.get(b.id).state, STATES.TARGET_PLACED);
  });

  await check('state survives a restart and reloads from disk', async () => {
    const file = tmpFile();
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w1 = new OcoWatcher({ client, stateFile: file });
    const b = w1.register({ ...LONG, entryOrderId: null });
    await w1.tick();
    const stopId = w1.brackets.get(b.id).stopOrderId;

    const w2 = new OcoWatcher({ client, stateFile: file });
    assert.strictEqual(w2.brackets.size, 1, 'bracket must reload');
    assert.strictEqual(w2.brackets.get(b.id).stopOrderId, stopId, 'the live stop id must survive');

    await w2.tick();
    assert.strictEqual(client.placed.length, 1, 'a restart must NOT duplicate the stop');
  });

  await check('a failed order-book read reports unhealthy and takes no action', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 }, listThrows: true });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    w.register({ ...LONG, entryOrderId: null });

    await w.tick().catch(() => {});
    assert.ok(w.health().lastError, 'the failure must be visible to the UI');
    assert.strictEqual(w.health().healthy, false);
    assert.strictEqual(client.placed.length, 0, 'nothing may be placed on unknown state');
  });

  await check('a trailing bracket places a REAL broker-held TRAILING_STOP_PRCT', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, stopPrice: undefined, trailingPercent: 8, entryOrderId: null });

    await w.tick();
    const after = w.brackets.get(b.id);
    assert.strictEqual(after.protective, 'TRAIL');
    assert.ok(after.stopOrderId, 'the trailing stop must be a real order at the broker');
    assert.strictEqual(client.placed[0].spec.priceType, 'TRAILING_STOP_PRCT');
    assert.strictEqual(Number(client.placed[0].spec.stopPrice), 8, 'trail rides in stopPrice as a percent');
    assert.strictEqual(client.placed[0].spec.orderTerm, 'GOOD_UNTIL_CANCEL');
  });

  await check('a take-profit-only bracket places nothing, then rotates in the target', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({
      ...LONG,
      stopPrice: undefined,
      trailingPercent: undefined,
      targetPrice: 110,
      entryOrderId: null,
    });

    await w.tick();
    assert.strictEqual(w.brackets.get(b.id).protective, 'NONE');
    assert.strictEqual(client.placed.length, 0, 'nothing to place when no stop was asked for');

    client.quotes.AAPL = 111;
    await w.tick();
    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.TARGET_PLACED);
    assert.strictEqual(client.placed.length, 1);
    assert.strictEqual(client.placed[0].spec.priceType, 'LIMIT');
    assert.strictEqual(client.cancelled.length, 0, 'there was no stop to cancel');
  });

  await check('a stop-only bracket never rotates, however far the price runs', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, targetPrice: undefined, entryOrderId: null });

    await w.tick(); // stop live
    client.quotes.AAPL = 500;
    await w.tick();
    await w.tick();

    const after = w.brackets.get(b.id);
    assert.strictEqual(after.state, STATES.ARMED, 'no target means nothing to rotate to');
    assert.strictEqual(client.placed.length, 1, 'only the stop was ever placed');
    assert.strictEqual(client.cancelled.length, 0, 'the stop must stay live');
  });

  await check('cancelling a bracket cancels the live stop too', async () => {
    const client = fakeClient({ quotes: { AAPL: 100 } });
    const w = new OcoWatcher({ client, stateFile: tmpFile() });
    const b = w.register({ ...LONG, entryOrderId: null });
    await w.tick();
    const stopId = w.brackets.get(b.id).stopOrderId;

    await w.cancel(b.id);
    assert.ok(client.cancelled.includes(stopId));
    assert.strictEqual(w.brackets.get(b.id).state, STATES.DONE);
  });

  console.log(`\n${passed} passed${process.exitCode ? ' (with failures above)' : ''}\n`);
})();
