/**
 * THE broker layer for the E*TRADE build — the drop-in replacement for `src/lib/api/ibkr.ts`.
 *
 * Same contract as the IBKR module: the UI never talks to a broker directly, it calls these
 * exports. Everything here goes through the NOVA E*TRADE proxy (never the broker from the
 * browser) because the proxy owns the OAuth token, the rate limiting and the bracket engine.
 *
 * What is deliberately carried over from the IBKR module:
 *   - post-submit order VERIFICATION (gotcha #1: an ACK is not proof the order exists)
 *   - GTC by default (gotcha #2: DAY orders die at the close)
 *   - a persistent last-known-price cache (gotcha #14: a feed hiccup must never show a stale number)
 *   - cancel working orders before a manual close (leftover children flip you short)
 *
 * What disappears because E*TRADE is not IBKR:
 *   - conid resolution (E*TRADE speaks plain symbols) — `resolveConids` stays as a no-op
 *     pass-through so call sites keep compiling
 *   - ssodh/init bridge, tickle two-strike logic, sticky auth windows, account re-priming
 */

const BASE = (import.meta.env.VITE_BROKER_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

// ---------------------------------------------------------------------------- types

export type SessionState = 'DISCONNECTED' | 'EXPIRED' | 'INACTIVE' | 'CONNECTED';

export interface AuthStatus {
  state: SessionState;
  connected: boolean;
  authenticated: boolean;
  accountIdKey: string | null;
  etradeEnv: 'sandbox' | 'production';
  etDay: string | null;
  idleMs: number | null;
  /** Synthetic bracket engine health — the UI must warn LOUDLY when this is unhealthy. */
  oco: { healthy: boolean; active: number; staleMs: number; lastError: string | null };
  /** Human-readable reason shown on the Topbar pill. */
  message: string;
}

export interface Quote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  /** REALTIME | DELAYED | CLOSING | EH_REALTIME … — never trade off DELAYED. */
  quoteStatus: string | null;
  stale?: boolean;
}

export interface Position {
  symbol: string;
  securityType: 'EQ' | 'OPTN' | string;
  quantity: number;
  avgCost: number | null;
  marketValue: number | null;
  lastPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dayPnl: number | null;
  positionId: string;
}

export interface BrokerOrder {
  orderId: string;
  status: string;
  symbol: string;
  action: string;
  quantity: number | null;
  filledQuantity: number;
  avgExecutionPrice: number | null;
  priceType: string;
  limitPrice: number | null;
  stopPrice: number | null;
  orderTerm: string;
  marketSession: string;
  placedTime: number | null;
  executedTime: number | null;
}

export interface AccountSummary {
  accountId: string;
  netAccountValue: number | null;
  cash: number | null;
  buyingPower: number | null;
  cashBuyingPower: number | null;
  marginBuyingPower: number | null;
  dayTradingBuyingPower: number | null;
}

export type OrderAction = 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT' | 'BUY_OPEN' | 'SELL_CLOSE' | 'BUY_CLOSE' | 'SELL_OPEN';
export type NovaOrderType = 'MKT' | 'LMT' | 'STP' | 'STP_LMT' | 'TRAIL' | 'MIT';

export interface PlaceOrderInput {
  symbol: string;
  action: OrderAction;
  quantity: number;
  orderType: NovaOrderType;
  limitPrice?: number;
  stopPrice?: number;
  /** percent for TRAIL */
  trailingPercent?: number;
  /** default GTC — do not pass DAY unless the trader explicitly chose it */
  tif?: 'GTC' | 'DAY' | 'IOC' | 'FOK';
  /** pre/after-market: forces LIMIT, as E*TRADE (like IBKR) rejects market orders outside RTH */
  outsideRth?: boolean;
  /** attach a synthetic bracket: a REAL broker-held stop + a proxy-watched target */
  bracket?: { stopPrice: number; targetPrice: number };
  /** options only */
  securityType?: 'EQ' | 'OPTN';
  underlying?: string;
  callPut?: 'CALL' | 'PUT';
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  strikePrice?: number;
}

export interface PlaceOrderResult {
  orderId: string | null;
  /** false => the order was NOT found in the broker's own order book. Shout about it. */
  verified: boolean;
  warning: string | null;
  estimatedCommission: number | null;
  estimatedTotalAmount: number | null;
  messages: Array<{ code?: string; description?: string; type?: string }>;
  bracketId: string | null;
}

export interface Bracket {
  id: string;
  symbol: string;
  quantity: number;
  positionSide: 'LONG' | 'SHORT';
  stopPrice: number;
  targetPrice: number;
  stopOrderId: string | null;
  targetOrderId: string | null;
  state: 'PENDING_ENTRY' | 'ARMED' | 'TARGET_PLACED' | 'DONE' | 'ERROR';
  note: string | null;
  updatedAt: number;
}

// ------------------------------------------------------------------- auth plumbing

let accessTokenProvider: () => string | null | Promise<string | null> = () => null;

/**
 * Wire this once at boot from `auth-context.tsx`:
 *   setAccessTokenProvider(() => supabase.auth.getSession().then(r => r.data.session?.access_token ?? null))
 * The proxy refuses every trading call without a valid, allow-listed Supabase session.
 */
export function setAccessTokenProvider(fn: typeof accessTokenProvider) {
  accessTokenProvider = fn;
}

let cachedAccountIdKey: string | null =
  (typeof localStorage !== 'undefined' && localStorage.getItem('nova_etrade_account')) || null;

export function getAccountIdKey() {
  return cachedAccountIdKey;
}

function setAccountIdKey(key: string | null) {
  cachedAccountIdKey = key;
  if (typeof localStorage !== 'undefined') {
    if (key) localStorage.setItem('nova_etrade_account', key);
    else localStorage.removeItem('nova_etrade_account');
  }
}

export class BrokerError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
    this.code = code;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!BASE) throw new BrokerError('VITE_BROKER_API_URL is not configured', 0);

  const token = await accessTokenProvider();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    throw new BrokerError(body?.error || `${res.status} ${res.statusText}`, res.status, body?.code ?? null);
  }
  return body as T;
}

function acct(): string {
  const key = cachedAccountIdKey;
  if (!key) throw new BrokerError('No E*TRADE account selected yet — connect the broker first', 409);
  return key;
}

// --------------------------------------------------------------------- session

export async function getAuthStatus(): Promise<AuthStatus> {
  const s = await api<any>('/api/status');
  if (s.accountIdKey && s.accountIdKey !== cachedAccountIdKey) setAccountIdKey(s.accountIdKey);

  const message =
    s.state === 'CONNECTED'
      ? 'Connected'
      : s.state === 'INACTIVE'
        ? 'Idle — reconnecting'
        : s.state === 'EXPIRED'
          ? 'Session expired at midnight ET — sign in to E*TRADE again'
          : 'Not connected';

  return {
    state: s.state,
    connected: s.state === 'CONNECTED' || s.state === 'INACTIVE',
    authenticated: s.state === 'CONNECTED',
    accountIdKey: s.accountIdKey ?? null,
    etradeEnv: s.etradeEnv,
    etDay: s.etDay ?? null,
    idleMs: s.idleMs ?? null,
    oco: s.oco,
    message,
  };
}

/**
 * IBKR parity: `tickle` kept the session warm. Here it reactivates a token idled past 2h.
 * It cannot resurrect a token that died at midnight ET — that needs `startAuth`.
 */
export async function tickle(): Promise<boolean> {
  const status = await getAuthStatus();
  if (status.state === 'CONNECTED') return true;
  if (status.state === 'INACTIVE') {
    await api('/api/auth/renew', { method: 'POST' });
    return true;
  }
  return false;
}

/** IBKR parity. Returns false when a human login is required. */
export async function ensureSession(): Promise<boolean> {
  return tickle();
}

/** Step 1 of the daily login: returns the E*TRADE URL the trader must open. */
export async function startAuth(): Promise<{ authorizeUrl: string }> {
  return api('/api/auth/start', { method: 'POST' });
}

/** Step 2: the 5-character code E*TRADE shows after the trader approves. */
export async function completeAuth(verifier: string) {
  const out = await api<{ ok: boolean; accounts: any[]; accountIdKey: string | null }>('/api/auth/complete', {
    method: 'POST',
    body: JSON.stringify({ verifier: verifier.trim() }),
  });
  if (out.accountIdKey) setAccountIdKey(out.accountIdKey);
  return out;
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  setAccountIdKey(null);
}

export async function listAccounts() {
  return api<Array<{ accountId: string; accountIdKey: string; accountName: string; accountStatus: string }>>(
    '/api/accounts'
  );
}

export function selectAccount(accountIdKey: string) {
  setAccountIdKey(accountIdKey);
}

// ---------------------------------------------------------------- market data

/**
 * Persistent last-known price per symbol (gotcha #14).
 * A refetch that returns nothing must never snap a card back to an older number, so the last
 * real print is merged in and flagged `stale` rather than dropped.
 */
const lastGoodQuote = new Map<string, Quote>();

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  const list = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return [];

  let rows: Quote[];
  try {
    rows = await api<Quote[]>(`/api/market/quote?symbols=${encodeURIComponent(list.join(','))}`);
  } catch (err) {
    // Feed hiccup: serve the last real prices rather than nulls, clearly marked stale.
    const fallback = list.map((s) => lastGoodQuote.get(s)).filter((q): q is Quote => !!q);
    if (fallback.length) return fallback.map((q) => ({ ...q, stale: true }));
    throw err;
  }

  const fresh = new Map(rows.map((q) => [q.symbol.toUpperCase(), q]));

  return list.map((sym) => {
    const q = fresh.get(sym);
    if (q && q.last != null) {
      lastGoodQuote.set(sym, q);
      return q;
    }
    // A missing or priceless row must not wipe a good price off the card (gotcha #14).
    const prev = lastGoodQuote.get(sym);
    if (prev) return { ...prev, stale: true };
    return q ?? emptyQuote(sym);
  });
}

function emptyQuote(symbol: string): Quote {
  return {
    symbol,
    last: null,
    bid: null,
    ask: null,
    open: null,
    high: null,
    low: null,
    prevClose: null,
    change: null,
    changePct: null,
    volume: null,
    quoteStatus: null,
    stale: true,
  };
}

export async function searchSymbols(query: string) {
  if (!query.trim()) return [];
  return api<Array<{ symbol: string; description: string; type: string }>>(
    `/api/market/lookup/${encodeURIComponent(query.trim())}`
  );
}

/**
 * E*TRADE speaks plain symbols — there is no conid. Kept so existing call sites compile.
 */
export async function resolveConids(symbols: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(symbols.map((s) => [s.toUpperCase(), s.toUpperCase()]));
}

/**
 * Charts stay on the existing TradeScope/Yahoo path — E*TRADE has no candle endpoint.
 * INTEGRATION POINT: match this route to TradeScope's real chart route in your build.
 */
export async function getChartData(symbol: string, range = '1d', interval = '5m') {
  const res = await fetch(
    `/ts-api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`
  );
  if (!res.ok) throw new BrokerError(`chart ${res.status}`, res.status);
  return res.json();
}

// ------------------------------------------------------------------- portfolio

export async function getAccountSummary(): Promise<AccountSummary> {
  return api<AccountSummary>(`/api/accounts/${acct()}/balance`);
}

export async function getPositions(): Promise<Position[]> {
  return api<Position[]>(`/api/accounts/${acct()}/portfolio`);
}

export async function getOrders(): Promise<BrokerOrder[]> {
  return api<BrokerOrder[]>(`/api/accounts/${acct()}/orders?count=100`);
}

// ---------------------------------------------------------------------- orders

const TIF_MAP: Record<NonNullable<PlaceOrderInput['tif']>, string> = {
  GTC: 'GOOD_UNTIL_CANCEL',
  DAY: 'GOOD_FOR_DAY',
  IOC: 'IMMEDIATE_OR_CANCEL',
  FOK: 'FILL_OR_KILL',
};

/** NOVA order type -> E*TRADE priceType. MIT has no E*TRADE equivalent (see note). */
function priceTypeFor(input: PlaceOrderInput): string {
  switch (input.orderType) {
    case 'MKT':
      return 'MARKET';
    case 'LMT':
      return 'LIMIT';
    case 'STP':
      return 'STOP';
    case 'STP_LMT':
      return 'STOP_LIMIT';
    case 'TRAIL':
      return 'TRAILING_STOP_PRCT';
    case 'MIT':
      // E*TRADE has no Market-If-Touched. A STOP is the broker-held equivalent for the same
      // intent (trigger -> market) and is safer than a server-side watcher, so use it.
      return 'STOP';
    default:
      return 'MARKET';
  }
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const outsideRth = !!input.outsideRth;

  // Extended hours is LIMIT-only at E*TRADE, exactly as it was at IBKR.
  if (outsideRth && input.orderType === 'MKT') {
    throw new BrokerError('Market orders are not accepted outside regular hours — use a limit order', 400);
  }

  const spec: Record<string, unknown> = {
    symbol: input.symbol.toUpperCase(),
    securityType: input.securityType ?? 'EQ',
    action: input.action,
    quantity: input.quantity,
    priceType: priceTypeFor(input),
    orderTerm: TIF_MAP[input.tif ?? 'GTC'], // GTC default — gotcha #2
    marketSession: outsideRth ? 'EXTENDED' : 'REGULAR',
  };

  if (input.limitPrice != null) spec.limitPrice = input.limitPrice;
  if (input.stopPrice != null) spec.stopPrice = input.stopPrice;
  if (input.orderType === 'TRAIL' && input.trailingPercent != null) spec.trailingAmount = input.trailingPercent;

  if (input.securityType === 'OPTN') {
    Object.assign(spec, {
      underlying: input.underlying ?? input.symbol,
      callPut: input.callPut,
      expiryYear: input.expiryYear,
      expiryMonth: input.expiryMonth,
      expiryDay: input.expiryDay,
      strikePrice: input.strikePrice,
    });
  }

  if (input.bracket) spec.bracket = input.bracket;

  const out = await api<any>(`/api/accounts/${acct()}/orders/submit`, {
    method: 'POST',
    body: JSON.stringify(spec),
  });

  return {
    orderId: out.orderId ?? null,
    verified: !!out.verified,
    warning: out.warning ?? null,
    estimatedCommission: out.estimatedCommission ?? null,
    estimatedTotalAmount: out.estimatedTotalAmount ?? null,
    messages: out.messages ?? [],
    bracketId: out.bracket?.id ?? null,
  };
}

export async function cancelOrder(orderId: string) {
  return api(`/api/accounts/${acct()}/orders/cancel`, {
    method: 'PUT',
    body: JSON.stringify({ orderId }),
  });
}

/**
 * Cancel every working order for a symbol.
 * Must run BEFORE a manual close — a leftover GTC stop/target executes later and flips the
 * position to the opposite side. This bit is broker-agnostic and was learned the hard way.
 */
export async function cancelWorkingOrders(symbol: string) {
  const orders = await getOrders();
  const working = orders.filter(
    (o) => o.symbol?.toUpperCase() === symbol.toUpperCase() && /OPEN|CANCEL_REQUESTED/i.test(o.status)
  );
  await Promise.all(working.map((o) => cancelOrder(o.orderId).catch(() => null)));

  // Synthetic brackets live in the proxy, not the order book — drop those too.
  const { brackets } = await getBrackets();
  await Promise.all(
    brackets
      .filter((b) => b.symbol.toUpperCase() === symbol.toUpperCase() && b.state !== 'DONE')
      .map((b) => cancelBracket(b.id).catch(() => null))
  );

  return working.length;
}

export async function closePosition(symbol: string) {
  const positions = await getPositions();
  const pos = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
  if (!pos || !pos.quantity) throw new BrokerError(`No open position in ${symbol}`, 404);

  await cancelWorkingOrders(symbol);

  const isOption = pos.securityType === 'OPTN';
  const long = pos.quantity > 0;
  return placeOrder({
    symbol,
    securityType: isOption ? 'OPTN' : 'EQ',
    action: isOption ? (long ? 'SELL_CLOSE' : 'BUY_CLOSE') : long ? 'SELL' : 'BUY_TO_COVER',
    quantity: Math.abs(pos.quantity),
    orderType: 'MKT',
    tif: 'GTC',
  });
}

// -------------------------------------------------------------------- brackets

export async function getBrackets(): Promise<{
  health: { healthy: boolean; active: number; staleMs: number; lastError: string | null };
  brackets: Bracket[];
}> {
  return api('/api/brackets');
}

export async function cancelBracket(id: string) {
  return api(`/api/brackets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --------------------------------------------------------------------- options

export async function getOptionMeta(symbol: string) {
  const dates = await api<Array<{ year: number; month: number; day: number; expiryType: string }>>(
    `/api/market/optionexpiredates?symbol=${encodeURIComponent(symbol)}`
  );
  return { symbol, expirations: dates };
}

export async function getOptionStrikes(
  symbol: string,
  expiry: { year: number; month: number; day: number },
  near?: number
) {
  return api<any[]>(
    `/api/market/optionchains?symbol=${encodeURIComponent(symbol)}&expiryYear=${expiry.year}` +
      `&expiryMonth=${expiry.month}&expiryDay=${expiry.day}` +
      (near != null ? `&strikePriceNear=${near}` : '') +
      `&noOfStrikes=40&chainType=CALLPUT`
  );
}

export async function getOptionQuotes(
  symbol: string,
  expiry: { year: number; month: number; day: number },
  near?: number
) {
  // The chain response already carries bid/ask/last/volume/OI per leg, so one call serves both.
  return getOptionStrikes(symbol, expiry, near);
}
