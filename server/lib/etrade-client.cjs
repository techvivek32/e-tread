/**
 * Signed REST client for the E*TRADE API.
 *
 * Every call is OAuth 1.0a signed, throttled, and normalised into the shapes NOVA's UI already
 * expects. Response envelopes (AccountListResponse, QuoteResponse, ...) are unwrapped here so
 * nothing above this file has to know E*TRADE's XML-flavoured JSON.
 *
 * Endpoint reference: https://apisb.etrade.com/docs/api/order/api-order-v1.html
 */

'use strict';

const { authHeader, parseTokenResponse } = require('./oauth1.cjs');
const series = require('./series.cjs');

const PROD = 'https://api.etrade.com';
const SANDBOX = 'https://apisb.etrade.com';
const AUTHORIZE_URL = 'https://us.etrade.com/e/t/etws/authorize';

class EtradeError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'EtradeError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** E*TRADE wraps single-element arrays inconsistently; normalise to a real array. */
function arr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

class EtradeClient {
  /**
   * @param {object} o
   * @param {string} o.consumerKey
   * @param {string} o.consumerSecret
   * @param {'sandbox'|'production'} o.env
   * @param {import('./token-store.cjs').TokenStore} o.tokens
   * @param {import('./throttle.cjs').Throttle} o.throttle
   */
  constructor({ consumerKey, consumerSecret, env, tokens, throttle }) {
    if (!consumerKey || !consumerSecret) throw new Error('ETRADE_CONSUMER_KEY/SECRET missing');
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.base = env === 'production' ? PROD : SANDBOX;
    this.env = env;
    this.tokens = tokens;
    this.throttle = throttle;
  }

  // ---------------------------------------------------------------- transport

  async _fetch(method, url, { token, tokenSecret, extra, body, raw } = {}) {
    const headers = {
      Authorization: authHeader({
        method,
        url,
        consumerKey: this.consumerKey,
        consumerSecret: this.consumerSecret,
        token,
        tokenSecret,
        extra,
      }),
      Accept: raw ? 'text/plain' : 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429) {
      this.throttle.noteRateLimited();
      throw new EtradeError('E*TRADE rate limit (429)', { status: 429 });
    }
    this.throttle.noteOk();

    // 204 = a genuine empty result on a healthy session (no orders / no positions).
    if (res.status === 204) return raw ? '' : null;

    const text = await res.text();

    if (!res.ok) {
      let code, message;
      try {
        const j = JSON.parse(text);
        code = j?.Error?.code;
        message = j?.Error?.message;
      } catch (_) {
        // Despite Accept: application/json, E*TRADE returns ORDER errors as XML
        // (<Error><code>30</code><message>...</message></Error>). Pull the fields out
        // so the code-specific hints below still fire.
        code = /<code>\s*(\d+)\s*<\/code>/.exec(text)?.[1];
        message = /<message>([^<]+)<\/message>/.exec(text)?.[1]?.trim();
      }
      // Error 30 means the ACCOUNT has not signed E*TRADE's Extended Hours Trading
      // agreement — nothing in this stack can fix it, and the bare message does not say
      // where to go. Point the trader at the fix instead of leaving them guessing.
      if (/Leveraged\/Inverse ETF|ETN Acknowledgment/i.test(message || '')) {
        message =
          'Your E*TRADE account has not accepted the Leveraged/Inverse ETF & ETN acknowledgment ' +
          '(these ETFs are leveraged products and E*TRADE requires a one-time sign-off). ' +
          'Log in at etrade.com, place any order for this ETF there once — it will prompt you to ' +
          'accept — then orders from here will work.';
      }
      if (String(code) === '30' || /Extended Hours Disclosure/i.test(message || '')) {
        message =
          'Your E*TRADE account has not signed the Extended Hours Trading agreement. ' +
          'Sign it on etrade.com (Accounts → Agreements / Extended Hours Trading), then retry — ' +
          'or untick After-hours to trade in regular hours.';
      }
      throw new EtradeError(message || `E*TRADE ${res.status}: ${text.slice(0, 300)}`, {
        status: res.status,
        code,
        body: text,
      });
    }

    if (raw) return text;
    try {
      return text ? JSON.parse(text) : null;
    } catch (_) {
      throw new EtradeError('E*TRADE returned a non-JSON body', { status: res.status, body: text });
    }
  }

  /** Signed, throttled API call using the stored access token. */
  async _api(method, path, { query, body } = {}) {
    const creds = this.tokens.credentials();
    if (!creds) {
      const { state } = this.tokens.status();
      throw new EtradeError(
        state === 'EXPIRED'
          ? 'E*TRADE session expired (tokens die at midnight ET) — a human must re-authorize'
          : 'Not connected to E*TRADE',
        { status: 401, code: state }
      );
    }

    const url = new URL(this.base + path);
    Object.entries(query || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    });

    const out = await this.throttle.run(() =>
      this._fetch(method, url.toString(), { token: creds.token, tokenSecret: creds.tokenSecret, body })
    );
    this.tokens.touch();
    return out;
  }

  // ------------------------------------------------------------ oauth 1.0a flow

  /** Step 1 — get a request token and the URL the human must visit. */
  async startAuth() {
    const url = `${this.base}/oauth/request_token`;
    const text = await this.throttle.run(() =>
      this._fetch('GET', url, { extra: { oauth_callback: 'oob' }, raw: true })
    );
    const parsed = parseTokenResponse(text);
    if (!parsed.oauth_token) throw new EtradeError('request_token returned no token', { body: text });

    return {
      requestToken: parsed.oauth_token,
      requestTokenSecret: parsed.oauth_token_secret,
      authorizeUrl: `${AUTHORIZE_URL}?key=${encodeURIComponent(this.consumerKey)}&token=${encodeURIComponent(
        parsed.oauth_token
      )}`,
    };
  }

  /** Step 2 — exchange the 5-character verification code for an access token. */
  async completeAuth({ requestToken, requestTokenSecret, verifier }) {
    const url = `${this.base}/oauth/access_token`;
    const text = await this.throttle.run(() =>
      this._fetch('GET', url, {
        token: requestToken,
        tokenSecret: requestTokenSecret,
        extra: { oauth_verifier: verifier },
        raw: true,
      })
    );
    const parsed = parseTokenResponse(text);
    if (!parsed.oauth_token) throw new EtradeError('access_token returned no token', { body: text });
    return { token: parsed.oauth_token, tokenSecret: parsed.oauth_token_secret };
  }

  /** Reactivates a token idled past 2h. Does NOT resurrect one that died at midnight ET. */
  async renew() {
    const creds = this.tokens.credentials();
    if (!creds) throw new EtradeError('nothing to renew — not connected', { status: 401 });
    await this.throttle.run(() =>
      this._fetch('GET', `${this.base}/oauth/renew_access_token`, {
        token: creds.token,
        tokenSecret: creds.tokenSecret,
        raw: true,
      })
    );
    this.tokens.touch();
    this.tokens.persistNow();
    return true;
  }

  async revoke() {
    const creds = this.tokens.credentials();
    if (!creds) return true;
    try {
      await this.throttle.run(() =>
        this._fetch('GET', `${this.base}/oauth/revoke_access_token`, {
          token: creds.token,
          tokenSecret: creds.tokenSecret,
          raw: true,
        })
      );
    } catch (e) {
      console.warn('[etrade] revoke failed (clearing locally anyway):', e.message);
    }
    return true;
  }

  // -------------------------------------------------------------------- accounts

  async listAccounts() {
    const j = await this._api('GET', '/v1/accounts/list');
    return arr(j?.AccountListResponse?.Accounts?.Account).map((a) => ({
      accountId: a.accountId,
      accountIdKey: a.accountIdKey,
      accountName: a.accountName || a.accountDesc || a.accountId,
      accountType: a.accountType,
      institutionType: a.institutionType,
      accountStatus: a.accountStatus,
    }));
  }

  async getBalance(accountIdKey) {
    const j = await this._api('GET', `/v1/accounts/${accountIdKey}/balance`, {
      query: { instType: 'BROKERAGE', realTimeNAV: 'true' },
    });
    const b = j?.BalanceResponse || {};
    const c = b.Computed || {};
    const rt = c.RealTimeValues || {};

    // Which of these a response carries depends on the account type (a cash account has no
    // margin buying power at all), so each falls back rather than reporting a hard zero.
    // `num()` returns 0 for a missing field, so ?? never fires — use a first-present pick.
    const first = (...vals) => {
      for (const v of vals) if (v !== undefined && v !== null && v !== '') return num(v);
      return null;
    };

    return {
      accountId: b.accountId,
      accountType: b.accountType,
      netAccountValue: first(rt.totalAccountValue, c.accountBalance, c.netCash),
      cash: first(c.cashAvailableForInvestment, c.cashBalance, c.netCash),
      settledCash: first(c.settledCashForInvestment),
      buyingPower: first(c.marginBuyingPower, c.cashBuyingPower, c.cashAvailableForInvestment),
      cashBuyingPower: first(c.cashBuyingPower, c.cashAvailableForInvestment),
      marginBuyingPower: first(c.marginBuyingPower),
      dayTradingBuyingPower: first(c.dtMarginBuyingPower, c.dtCashBuyingPower),
      // E*TRADE's balance has no unrealized-gain figure. Reporting 0 while positions are open
      // would be a lie, so it stays null and the UI sums it from the positions it already has.
      totalUnrealizedGain: null,
      raw: b,
    };
  }

  async getPortfolio(accountIdKey) {
    // 204 => genuinely flat. Only treat an ERROR as "unknown" (gotcha #3: empty != gone).
    const j = await this._api('GET', `/v1/accounts/${accountIdKey}/portfolio`, {
      query: { count: 250, view: 'COMPLETE' },
    });
    if (!j) return [];

    const groups = arr(j?.PortfolioResponse?.AccountPortfolio);
    const out = [];
    groups.forEach((g) =>
      arr(g.Position).forEach((p) => {
        const q = p.Quick || {};
        out.push({
          symbol: p.Product?.symbol || p.symbolDescription,
          securityType: p.Product?.securityType || 'EQ',
          positionId: String(p.positionId ?? ''),
          quantity: num(p.quantity) ?? 0,
          avgCost: num(p.pricePaid),
          marketValue: num(p.marketValue),
          lastPrice: num(q.lastTrade) ?? num(p.marketValue) / (num(p.quantity) || 1),
          unrealizedPnl: num(p.totalGain),
          unrealizedPnlPct: num(p.totalGainPct),
          dayPnl: num(p.daysGain),
          product: p.Product || null,
          raw: p,
        });
      })
    );
    return out;
  }

  /**
   * Executed transactions. E*TRADE's own trade feed, used for the all-time archive.
   * Dates are MMDDYYYY; a window is derived from `days` so callers keep the IBKR-style API.
   */
  async getTransactions(accountIdKey, { days = 6, count = 50 } = {}) {
    // Measured against the live API: count > 50 makes this endpoint return HTTP 500, with no
    // error body explaining why. Clamp rather than let a caller's larger page size kill the
    // trade archive. Paging beyond 50 uses the `marker` the response carries.
    count = Math.min(Number(count) || 50, 50);
    const fmt = (d) =>
      `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${d.getFullYear()}`;
    const end = new Date();
    const start = new Date(end.getTime() - Math.max(1, days) * 86400000);

    const j = await this._api('GET', `/v1/accounts/${accountIdKey}/transactions`, {
      query: { startDate: fmt(start), endDate: fmt(end), count, sortOrder: 'DESC' },
    });
    if (!j) return [];

    return arr(j?.TransactionListResponse?.Transaction).map((t) => {
      // E*TRADE lower-cases these two keys here and only here (`brokerage`/`product`), unlike
      // the Pascal-cased envelopes everywhere else. Accept both spellings.
      const b = t.brokerage || t.Brokerage || {};
      const prod = b.product || b.Product || {};
      return {
        transactionId: String(t.transactionId ?? ''),
        orderNo: String(b.orderNo ?? ''),
        symbol: (prod.symbol || String(b.displaySymbol ?? '').trim() || '').toUpperCase(),
        securityType: prod.securityType || 'EQ',
        // Quantity is signed at E*TRADE: positive bought, negative sold.
        quantity: num(b.quantity),
        price: num(b.price),
        commission: num(b.fee),
        netAmount: num(t.amount),
        // Sandbox returns seconds, production returns milliseconds, with nothing in the
        // response saying which. Anything below ~2001-09-09 in ms cannot be a real trade date,
        // so treat it as seconds and scale it. Always milliseconds out of here.
        transactionDate: (() => {
          const v = Number(t.transactionDate) || 0;
          return v > 0 && v < 1e12 ? v * 1000 : v;
        })(),
        description: t.description || '',
        transactionType: t.transactionType || '',
        raw: t,
      };
    });
  }

  // ---------------------------------------------------------------------- orders

  /**
   * @param {string} accountIdKey
   * @param {object} [opts] { status, fromDate, toDate, count, marketSession, symbol }
   *   status: OPEN|EXECUTED|CANCELLED|INDIVIDUAL_FILLS|CANCEL_REQUESTED|EXPIRED|REJECTED
   *   dates are MMDDYYYY
   */
  async listOrders(accountIdKey, opts = {}) {
    const j = await this._api('GET', `/v1/accounts/${accountIdKey}/orders`, {
      query: {
        // Measured against the live API: count above 100 is refused outright ("Invalid
        // count specified. The count should be between 1 and 100"), and one oversized
        // caller silently blinded the bracket watcher. Clamp here so no caller can.
        count: Math.min(Number(opts.count) || 100, 100),
        status: opts.status,
        fromDate: opts.fromDate,
        toDate: opts.toDate,
        symbol: opts.symbol,
        marketSession: opts.marketSession,
      },
    });
    if (!j) return [];

    return arr(j?.OrdersResponse?.Order).map((o) => {
      const d = arr(o.OrderDetail)[0] || {};
      const inst = arr(d.Instrument)[0] || {};
      return {
        orderId: String(o.orderId),
        orderType: o.orderType,
        status: d.status,
        symbol: inst.Product?.symbol || inst.symbolDescription,
        securityType: inst.Product?.securityType,
        action: inst.orderAction,
        quantity: num(inst.orderedQuantity) ?? num(inst.quantity),
        filledQuantity: num(inst.filledQuantity) ?? 0,
        avgExecutionPrice: num(inst.averageExecutionPrice),
        priceType: d.priceType,
        limitPrice: num(d.limitPrice),
        stopPrice: num(d.stopPrice),
        orderTerm: d.orderTerm,
        marketSession: d.marketSession,
        placedTime: num(d.placedTime),
        executedTime: num(d.executedTime),
        netPrice: num(d.netPrice),
        product: inst.Product || null,
        raw: o,
      };
    });
  }

  /**
   * Build the E*TRADE Order payload from NOVA's normalised order spec.
   * Shapes verified against the Preview/Place Order docs.
   */
  buildOrder(spec) {
    const isOption = spec.securityType === 'OPTN';
    const product = isOption
      ? {
          symbol: spec.underlying || spec.symbol,
          securityType: 'OPTN',
          callPut: spec.callPut, // CALL | PUT
          expiryYear: spec.expiryYear,
          expiryMonth: spec.expiryMonth,
          expiryDay: spec.expiryDay,
          strikePrice: spec.strikePrice,
        }
      : { symbol: spec.symbol, securityType: 'EQ' };

    const order = {
      allOrNone: String(!!spec.allOrNone),
      priceType: spec.priceType, // MARKET | LIMIT | STOP | STOP_LIMIT | TRAILING_STOP_PRCT | TRAILING_STOP_CNST
      orderTerm: spec.orderTerm || 'GOOD_UNTIL_CANCEL', // GTC by default — gotcha #2
      marketSession: spec.marketSession || 'REGULAR',
      Instrument: [
        {
          Product: product,
          orderAction: spec.action, // BUY | SELL | BUY_TO_COVER | SELL_SHORT | BUY_OPEN | SELL_CLOSE ...
          quantityType: 'QUANTITY',
          quantity: String(spec.quantity),
        },
      ],
    };

    // Outside regular hours E*TRADE accepts DAY LIMIT orders only. A GTC term with an
    // EXTENDED session is rejected with error code 5, "The term you specified for this
    // order is invalid" — which reaches a trader as a cryptic failure at the moment they
    // are trying to act. Enforce the rule here, where every caller passes through, rather
    // than trusting each UI to remember it.
    if (order.marketSession === 'EXTENDED' || order.marketSession === 'EXTO') {
      if (order.priceType !== 'LIMIT') {
        throw new EtradeError(
          'Outside regular hours E*TRADE accepts limit orders only — pick a limit price',
          { status: 400, code: 'EXTENDED_LIMIT_ONLY' }
        );
      }
      order.orderTerm = 'GOOD_FOR_DAY';
    }

    if (spec.limitPrice != null) order.limitPrice = String(spec.limitPrice);
    if (spec.stopPrice != null) order.stopPrice = String(spec.stopPrice);
    if (spec.trailingAmount != null) {
      // TRAILING_STOP_PRCT uses a percentage, TRAILING_STOP_CNST a dollar offset — both ride stopPrice.
      order.stopPrice = String(spec.trailingAmount);
    }

    return { orderType: isOption ? 'OPTN' : 'EQ', order };
  }

  /** clientOrderId: max 20 alphanumeric chars, must differ per submission. */
  static clientOrderId() {
    return `NOVA${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)
      .toString(36)
      .padStart(3, '0')}`
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 20);
  }

  async previewOrder(accountIdKey, spec) {
    const { orderType, order } = this.buildOrder(spec);
    const clientOrderId = spec.clientOrderId || EtradeClient.clientOrderId();

    const j = await this._api('POST', `/v1/accounts/${accountIdKey}/orders/preview`, {
      body: { PreviewOrderRequest: { orderType, clientOrderId, Order: [order] } },
    });

    const r = j?.PreviewOrderResponse || {};
    return {
      clientOrderId,
      orderType,
      order,
      previewIds: arr(r.PreviewIds).map((p) => ({ previewId: p.previewId, cashMargin: p.cashMargin })),
      // These are the trader-facing numbers IBKR never gave us — surface them in the modal.
      estimatedCommission: num(r.Order?.[0]?.estimatedCommission ?? arr(r.Order)[0]?.estimatedCommission),
      estimatedTotalAmount: num(arr(r.Order)[0]?.estimatedTotalAmount),
      messages: arr(arr(r.Order)[0]?.messages?.Message).map((m) => ({
        code: m.code,
        description: m.description,
        type: m.type,
      })),
      raw: r,
    };
  }

  /**
   * previewId is valid for 3 minutes and the order body must match the preview EXACTLY —
   * that is why we replay the same `order` object rather than rebuilding it.
   */
  async placeOrder(accountIdKey, preview) {
    const j = await this._api('POST', `/v1/accounts/${accountIdKey}/orders/place`, {
      body: {
        PlaceOrderRequest: {
          orderType: preview.orderType,
          clientOrderId: preview.clientOrderId,
          PreviewIds: preview.previewIds,
          Order: [preview.order],
        },
      },
    });

    const r = j?.PlaceOrderResponse || {};
    const orderId = arr(r.OrderIds)[0]?.orderId;
    return {
      orderId: orderId != null ? String(orderId) : null,
      clientOrderId: preview.clientOrderId,
      messages: arr(arr(r.Order)[0]?.messages?.Message).map((m) => ({
        code: m.code,
        description: m.description,
        type: m.type,
      })),
      raw: r,
    };
  }

  async cancelOrder(accountIdKey, orderId) {
    const j = await this._api('PUT', `/v1/accounts/${accountIdKey}/orders/cancel`, {
      body: { CancelOrderRequest: { orderId: Number(orderId) } },
    });
    return { orderId: String(orderId), raw: j?.CancelOrderResponse || null };
  }

  /**
   * Post-submit verification. The single most important lesson from IBKR (gotcha #1):
   * an ACK is not proof the order exists. Poll the real order book before telling the trader
   * anything landed.
   */
  async verifyOrderLive(accountIdKey, orderId, { attempts = 6, delayMs = 1500 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        const orders = await this.listOrders(accountIdKey, { count: 100 });
        const found = orders.find((o) => String(o.orderId) === String(orderId));
        if (found) return { verified: true, order: found, attempts: i + 1 };
      } catch (e) {
        // A transient error is not proof of absence — keep polling.
        console.warn(`[etrade] verify attempt ${i + 1} failed:`, e.message);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return { verified: false, order: null, attempts };
  }

  // ---------------------------------------------------------------- market data

  /**
   * E*TRADE allows 25 symbols per call, 50 with overrideSymbolCount=true.
   * Anything longer is chunked here so callers never have to care.
   */
  async getQuotes(symbols, { detailFlag = 'ALL' } = {}) {
    const list = arr(symbols).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    if (!list.length) return [];

    const CHUNK = 50;
    const chunks = [];
    for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));

    const results = await Promise.all(
      chunks.map((chunk) =>
        // The comma separator MUST stay raw. Percent-encoding it to %2C makes our signature
        // base string disagree with the one E*TRADE computes, and every multi-symbol request
        // comes back oauth_problem=signature_invalid. Tickers are alphanumeric plus . and -,
        // all legal unencoded in a path segment.
        this._api('GET', `/v1/market/quote/${chunk.join(',')}`, {
          query: { detailFlag, overrideSymbolCount: chunk.length > 25 ? 'true' : undefined },
        })
      )
    );

    const out = [];
    results.forEach((j) =>
      arr(j?.QuoteResponse?.QuoteData).forEach((q) => {
        const a = q.All || {};
        out.push({
          symbol: q.Product?.symbol || a.symbolDescription,
          last: num(a.lastTrade),
          bid: num(a.bid),
          ask: num(a.ask),
          open: num(a.open),
          high: num(a.high),
          low: num(a.low),
          prevClose: num(a.previousClose),
          change: num(a.changeClose),
          changePct: num(a.changeClosePercentage),
          volume: num(a.totalVolume),
          quoteStatus: q.quoteStatus, // REALTIME | DELAYED | CLOSING | EH_REALTIME ...
          dateTimeUTC: num(q.dateTimeUTC),
          raw: q,
        });
      })
    );
    // Feed the intraday recorder. E*TRADE has no history endpoint, so the chart is built
    // from these same quotes rather than from a second source that could disagree with the
    // price the order desk is using.
    series.recordAll(out);
    return out;
  }

  async lookup(search) {
    const j = await this._api('GET', `/v1/market/lookup/${encodeURIComponent(search)}`);
    return arr(j?.LookupResponse?.Data).map((d) => ({
      symbol: d.symbol,
      description: d.description,
      type: d.type,
    }));
  }

  async optionExpireDates(symbol, { expiryType } = {}) {
    const j = await this._api('GET', '/v1/market/optionexpiredate', {
      query: { symbol, expiryType },
    });
    return arr(j?.OptionExpireDateResponse?.ExpirationDate).map((d) => ({
      year: num(d.year),
      month: num(d.month),
      day: num(d.day),
      expiryType: d.expiryType,
    }));
  }

  async optionChains(symbol, { expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes = 20, chainType = 'CALLPUT' } = {}) {
    const j = await this._api('GET', '/v1/market/optionchains', {
      query: {
        symbol,
        expiryYear,
        expiryMonth,
        expiryDay,
        strikePriceNear,
        noOfStrikes,
        chainType,
        includeWeekly: 'true',
      },
    });
    return arr(j?.OptionChainResponse?.OptionPair).map((p) => ({
      call: p.Call || null,
      put: p.Put || null,
      pairType: p.pairType,
    }));
  }
}

module.exports = { EtradeClient, EtradeError, PROD, SANDBOX, AUTHORIZE_URL, arr, num };
