/**
 * Synthetic bracket / OCO engine.
 *
 * E*TRADE's API cannot place bracket or contingent orders — the docs say so outright
 * ("bracketed orders are not supported in API currently"). NOVA's UI offers brackets, so we
 * build them here, with one non-negotiable rule:
 *
 *      THE STOP IS A REAL BROKER-HELD GTC ORDER. THE TARGET IS THE SYNTHETIC HALF.
 *
 * If this server dies, the trader is still protected — they lose an unfilled target (upside),
 * never their stop (capital). That asymmetry is the whole design.
 *
 * Lifecycle
 *   PENDING_ENTRY  entry order working; nothing else placed yet
 *   ARMED          entry filled, REAL stop is live at E*TRADE, we watch the price for the target
 *   TARGET_PLACED  target touched: stop cancelled (verified) then target placed (verified)
 *   DONE           stop or target filled, or the position is gone
 *   ERROR          something we refuse to guess about — surfaced LOUDLY in the UI (gotcha #21)
 *
 * Safety invariants (violating any of these can flip a position short — gotcha: leftover
 * GTC children execute later):
 *   1. Never place the target until the stop cancel is CONFIRMED gone from the order book.
 *   2. Never act on a failed/stale quote — no data means no decision.
 *   3. State is persisted BEFORE and AFTER every order action, so a crash mid-flight is
 *      recoverable by reconciliation rather than by guessing.
 *   4. Reconcile against the real order book on boot before taking any action.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATES = {
  PENDING_ENTRY: 'PENDING_ENTRY',
  ARMED: 'ARMED',
  TARGET_PLACED: 'TARGET_PLACED',
  DONE: 'DONE',
  ERROR: 'ERROR',
};

const TERMINAL_ORDER_STATUS = new Set(['EXECUTED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class OcoWatcher {
  /**
   * @param {object} o
   * @param {import('./etrade-client.cjs').EtradeClient} o.client
   * @param {string} o.stateFile
   * @param {number} [o.intervalMs]
   */
  constructor({ client, stateFile, intervalMs = 5000 }) {
    this.client = client;
    this.stateFile = stateFile;
    this.intervalMs = intervalMs;

    /** @type {Map<string, any>} */
    this.brackets = new Map();
    this.timer = null;
    this.lastTickAt = 0;
    this.lastError = null;
    this.reconciled = false;
    this._busy = false;

    this._load();
  }

  // ------------------------------------------------------------------ persistence

  _load() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const rows = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      rows.forEach((b) => this.brackets.set(b.id, b));
      console.log(`[oco] loaded ${this.brackets.size} bracket(s) from disk`);
    } catch (e) {
      // Do NOT start with an empty map pretending all is well — a lost bracket is a live risk.
      this.lastError = `bracket state unreadable: ${e.message}`;
      console.error('[oco] FATAL: could not read bracket state —', e.message);
    }
  }

  _save() {
    try {
      atomicWrite(this.stateFile, JSON.stringify([...this.brackets.values()], null, 2));
    } catch (e) {
      this.lastError = `bracket state unwritable: ${e.message}`;
      console.error('[oco] could not persist bracket state:', e.message);
    }
  }

  // ---------------------------------------------------------------------- lifecycle

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    console.log(`[oco] watcher started (${this.intervalMs}ms)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * @returns {{healthy:boolean, lastTickAt:number, staleMs:number, active:number, reconciled:boolean, lastError:string|null}}
   */
  health() {
    const active = [...this.brackets.values()].filter(
      (b) => b.state === STATES.PENDING_ENTRY || b.state === STATES.ARMED || b.state === STATES.TARGET_PLACED
    ).length;
    const staleMs = this.lastTickAt ? Date.now() - this.lastTickAt : Infinity;
    return {
      healthy: this.reconciled && staleMs < this.intervalMs * 4 && !this.lastError,
      lastTickAt: this.lastTickAt,
      staleMs: Number.isFinite(staleMs) ? staleMs : -1,
      active,
      reconciled: this.reconciled,
      lastError: this.lastError,
    };
  }

  list() {
    return [...this.brackets.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ------------------------------------------------------------------ registration

  /**
   * Register a bracket. Called right after the ENTRY order is placed AND verified.
   *
   * @param {object} o
   * @param {string} o.accountIdKey
   * @param {string} o.symbol
   * @param {'EQ'|'OPTN'} [o.securityType]
   * @param {number} o.quantity
   * @param {'LONG'|'SHORT'} o.positionSide  direction of the position being protected
   * @param {string|null} o.entryOrderId     null if the position already exists
   * @param {number} o.stopPrice
   * @param {number} o.targetPrice
   * @param {object} [o.product]             option product fields, if securityType === 'OPTN'
   */
  register(o) {
    const id = `br_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const bracket = {
      id,
      accountIdKey: o.accountIdKey,
      symbol: String(o.symbol).toUpperCase(),
      securityType: o.securityType || 'EQ',
      product: o.product || null,
      quantity: Number(o.quantity),
      positionSide: o.positionSide,
      entryOrderId: o.entryOrderId ? String(o.entryOrderId) : null,
      stopPrice: Number(o.stopPrice),
      targetPrice: Number(o.targetPrice),
      stopOrderId: null,
      targetOrderId: null,
      state: o.entryOrderId ? STATES.PENDING_ENTRY : STATES.ARMED,
      note: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // No entry order means the position is already open — arm the stop on the next tick.
    this.brackets.set(id, bracket);
    this._save();
    console.log(`[oco] registered ${id} ${bracket.symbol} qty=${bracket.quantity} stop=${bracket.stopPrice} target=${bracket.targetPrice}`);
    return bracket;
  }

  /** Cancel a bracket: cancels the live stop too, unless it already filled. */
  async cancel(id) {
    const b = this.brackets.get(id);
    if (!b) return null;

    if (b.stopOrderId && b.state !== STATES.DONE) {
      try {
        await this.client.cancelOrder(b.accountIdKey, b.stopOrderId);
      } catch (e) {
        console.warn(`[oco] ${id}: stop cancel failed —`, e.message);
      }
    }
    b.state = STATES.DONE;
    b.note = 'cancelled by user';
    b.updatedAt = Date.now();
    this._save();
    return b;
  }

  // ----------------------------------------------------------------------- the loop

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const active = this.list().filter(
        (b) => b.state === STATES.PENDING_ENTRY || b.state === STATES.ARMED || b.state === STATES.TARGET_PLACED
      );

      if (!active.length) {
        this.reconciled = true;
        this.lastTickAt = Date.now();
        this.lastError = null;
        return;
      }

      // One order-book read per account per tick, shared by every bracket on it.
      const accounts = [...new Set(active.map((b) => b.accountIdKey))];
      const ordersByAccount = new Map();
      for (const key of accounts) {
        ordersByAccount.set(key, await this.client.listOrders(key, { count: 200 }));
      }
      this.reconciled = true;

      // One quote call for every symbol we are watching.
      const symbols = [...new Set(active.filter((b) => b.state === STATES.ARMED).map((b) => b.symbol))];
      const quotes = new Map();
      if (symbols.length) {
        const qs = await this.client.getQuotes(symbols);
        qs.forEach((q) => quotes.set(q.symbol, q));
      }

      for (const b of active) {
        try {
          await this._advance(b, ordersByAccount.get(b.accountIdKey) || [], quotes.get(b.symbol));
        } catch (e) {
          b.state = STATES.ERROR;
          b.note = e.message;
          b.updatedAt = Date.now();
          console.error(`[oco] ${b.id} ERROR:`, e.message);
        }
      }

      this._save();
      this.lastTickAt = Date.now();
      this.lastError = null;
    } catch (e) {
      // Invariant 2: a failed read means we know nothing. Do not act, do flag it.
      this.lastError = e.message;
      console.error('[oco] tick failed:', e.message);
      throw e;
    } finally {
      this._busy = false;
    }
  }

  async _advance(b, orders, quote) {
    const byId = (id) => orders.find((o) => String(o.orderId) === String(id));
    const closeAction =
      b.securityType === 'OPTN'
        ? b.positionSide === 'LONG' ? 'SELL_CLOSE' : 'BUY_CLOSE'
        : b.positionSide === 'LONG' ? 'SELL' : 'BUY_TO_COVER';

    // ---- 1. waiting for the entry to fill
    if (b.state === STATES.PENDING_ENTRY) {
      const entry = byId(b.entryOrderId);
      if (!entry) return; // not visible yet — the trade feed lags; do nothing, do not assume
      if (entry.status === 'EXECUTED' || (entry.filledQuantity || 0) >= b.quantity) {
        b.state = STATES.ARMED;
        b.updatedAt = Date.now();
        this._save();
      } else if (TERMINAL_ORDER_STATUS.has(entry.status)) {
        b.state = STATES.DONE;
        b.note = `entry ${entry.status} — bracket dropped`;
        b.updatedAt = Date.now();
      }
      return;
    }

    // ---- 2. armed: make sure the REAL stop exists, then watch for the target
    if (b.state === STATES.ARMED) {
      const stop = b.stopOrderId ? byId(b.stopOrderId) : null;

      if (b.stopOrderId && stop && stop.status === 'EXECUTED') {
        b.state = STATES.DONE;
        b.note = 'stopped out';
        b.updatedAt = Date.now();
        return;
      }
      if (b.stopOrderId && stop && TERMINAL_ORDER_STATUS.has(stop.status)) {
        b.state = STATES.ERROR;
        b.note = `stop order ${stop.status} unexpectedly — position may be UNPROTECTED`;
        return;
      }

      // Place the real broker-held stop once.
      if (!b.stopOrderId) {
        b.note = 'placing protective stop';
        b.updatedAt = Date.now();
        this._save(); // invariant 3: persist intent before acting

        const spec = {
          symbol: b.symbol,
          securityType: b.securityType,
          ...(b.product || {}),
          action: closeAction,
          quantity: b.quantity,
          priceType: 'STOP',
          stopPrice: b.stopPrice,
          orderTerm: 'GOOD_UNTIL_CANCEL',
          marketSession: 'REGULAR',
        };
        const preview = await this.client.previewOrder(b.accountIdKey, spec);
        const placed = await this.client.placeOrder(b.accountIdKey, preview);
        const check = await this.client.verifyOrderLive(b.accountIdKey, placed.orderId);
        if (!check.verified) {
          b.state = STATES.ERROR;
          b.note = 'STOP ORDER NOT VERIFIED AT BROKER — position is UNPROTECTED, act manually';
          return;
        }
        b.stopOrderId = String(placed.orderId);
        b.note = 'protected: stop live at broker';
        b.updatedAt = Date.now();
        this._save();
        console.log(`[oco] ${b.id}: stop ${b.stopOrderId} live @ ${b.stopPrice}`);
        return;
      }

      // Watch for the target. No quote => no decision (invariant 2).
      if (!quote || quote.last == null) return;
      const touched = b.positionSide === 'LONG' ? quote.last >= b.targetPrice : quote.last <= b.targetPrice;
      if (!touched) return;

      console.log(`[oco] ${b.id}: target touched (${quote.last} vs ${b.targetPrice}) — rotating stop -> target`);
      b.note = 'target touched: cancelling stop';
      b.updatedAt = Date.now();
      this._save();

      // Invariant 1: the stop must be CONFIRMED gone before the target goes in, or both could
      // fill and flip the position to the opposite side.
      await this.client.cancelOrder(b.accountIdKey, b.stopOrderId);
      const gone = await this._confirmGone(b.accountIdKey, b.stopOrderId);
      if (!gone) {
        b.state = STATES.ERROR;
        b.note = 'could not confirm stop cancellation — target NOT placed (refusing to risk a double exit)';
        return;
      }

      const spec = {
        symbol: b.symbol,
        securityType: b.securityType,
        ...(b.product || {}),
        action: closeAction,
        quantity: b.quantity,
        priceType: 'LIMIT',
        limitPrice: b.targetPrice,
        orderTerm: 'GOOD_UNTIL_CANCEL',
        marketSession: 'REGULAR',
      };
      const preview = await this.client.previewOrder(b.accountIdKey, spec);
      const placed = await this.client.placeOrder(b.accountIdKey, preview);
      const check = await this.client.verifyOrderLive(b.accountIdKey, placed.orderId);
      if (!check.verified) {
        b.state = STATES.ERROR;
        b.note = 'TARGET NOT VERIFIED and stop already cancelled — position UNPROTECTED, act manually';
        return;
      }
      b.targetOrderId = String(placed.orderId);
      b.stopOrderId = null;
      b.state = STATES.TARGET_PLACED;
      b.note = 'target live at broker';
      b.updatedAt = Date.now();
      this._save();
      return;
    }

    // ---- 3. target working
    if (b.state === STATES.TARGET_PLACED) {
      const target = byId(b.targetOrderId);
      if (!target) return;
      if (target.status === 'EXECUTED') {
        b.state = STATES.DONE;
        b.note = 'target filled';
        b.updatedAt = Date.now();
      } else if (TERMINAL_ORDER_STATUS.has(target.status)) {
        b.state = STATES.ERROR;
        b.note = `target ${target.status} — position has no stop and no target`;
      }
    }
  }

  /** Poll the order book until the order is absent or terminal. */
  async _confirmGone(accountIdKey, orderId, { attempts = 6, delayMs = 1500 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        const orders = await this.client.listOrders(accountIdKey, { count: 200 });
        const found = orders.find((o) => String(o.orderId) === String(orderId));
        if (!found) return true;
        if (found.status === 'CANCELLED' || found.status === 'EXPIRED' || found.status === 'REJECTED') return true;
        if (found.status === 'EXECUTED') return false; // it filled — the stop did its job
      } catch (e) {
        console.warn(`[oco] confirmGone attempt ${i + 1}:`, e.message);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }
}

module.exports = { OcoWatcher, STATES };
