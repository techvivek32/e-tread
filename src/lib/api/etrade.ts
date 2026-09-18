// E*TRADE broker API layer — the drop-in replacement for ibkr.ts.
//
// Every export here matches the IBKR module's name, signature and return shape, so the ~22
// UI files that used to import "@/lib/api/ibkr" only change their import path. Nothing else
// in the app knows the broker changed.
//
// Three structural differences from IBKR, absorbed here so callers never see them:
//
//  1. NO CONID. E*TRADE speaks plain symbols, but this codebase is conid-centric
//     (Position.conid, getChartData(conid), closePosition(conid, qty), getOptionQuotes(conids)…).
//     So we mint STABLE SYNTHETIC conids from a local registry and map them back on the way in.
//     Every existing call site keeps working.
//
//  2. NO BRACKETS. E*TRADE's API cannot place bracket/OCO orders. The protective stop is placed
//     as a REAL broker-held GTC order; the take-profit is watched by the proxy's OCO engine.
//     A dead server therefore costs an unfilled target, never an unprotected position.
//
//  3. NO JAVA GATEWAY, and no ssodh/init bridge. The session is an OAuth 1.0a token the proxy
//     holds. It dies at MIDNIGHT ET (a human must re-authorise) and goes idle after 2h
//     (recoverable — that is what tickle() does here).

import { supabase } from "@/integrations/supabase/client";

const PROXY: string = (import.meta.env.VITE_BROKER_API_URL ?? "").replace(/\/$/, "");

/** Where the user connects the broker. E*TRADE's OAuth flow lives on our own Broker page. */
export const GATEWAY_LOGIN_URL = "/broker";

// The account this instance trades. Pinned by env when set; otherwise adopted from
// /v1/accounts/list after the first login (same multi-account model as the IBKR build).
const ENV_ACCOUNT: string =
  import.meta.env.VITE_ETRADE_ACCOUNT_ID_KEY ?? import.meta.env.VITE_IBKR_ACCOUNT_ID ?? "";
let CURRENT_ACCOUNT = ENV_ACCOUNT;

// Storage/event names are deliberately unchanged from the IBKR build so trading-context.tsx
// needs nothing but a new import path.
const ACCOUNT_KEY = "nova_ibkr_account";
const ACCOUNT_EVENT = "nova:ibkr-account";

if (typeof window !== "undefined" && !CURRENT_ACCOUNT) {
  try {
    CURRENT_ACCOUNT = localStorage.getItem(ACCOUNT_KEY) ?? "";
  } catch {
    /* private mode */
  }
}

export function setIBKRAccount(id: string) {
  if (id) CURRENT_ACCOUNT = id;
}

export function getIBKRAccount() {
  return CURRENT_ACCOUNT;
}

function adoptDetectedAccount(accountIdKey: string | undefined | null) {
  if (ENV_ACCOUNT) return;
  if (!accountIdKey || accountIdKey === CURRENT_ACCOUNT) return;
  CURRENT_ACCOUNT = accountIdKey;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(ACCOUNT_KEY, accountIdKey);
    } catch {
      /* private mode */
    }
    window.dispatchEvent(new CustomEvent(ACCOUNT_EVENT, { detail: accountIdKey }));
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** The proxy authorises callers by Supabase JWT — it refuses anonymous trading calls. */
async function authHeader(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${PROXY}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(await authHeader()),
      ...options?.headers,
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(body?.error || `E*TRADE ${res.status}: ${text.slice(0, 200)}`);
  return body as T;
}

function requireAccount(): string {
  if (!CURRENT_ACCOUNT) {
    throw new Error("E*TRADE account not detected yet — connect the broker, then retry.");
  }
  return CURRENT_ACCOUNT;
}

// ---------------------------------------------------------------------------
// Synthetic contract ids
// ---------------------------------------------------------------------------
//
// The UI passes `conid: number` around for stocks AND option legs. E*TRADE has no such id, so
// we mint one per contract and remember the mapping. Ids start above 10_000_000 so they can
// never be confused with a real IBKR conid left in an old localStorage cache.

type Ref =
  | { kind: "STK"; symbol: string }
  | {
      kind: "OPT";
      underlying: string;
      year: number;
      month: number;
      day: number;
      right: "C" | "P";
      strike: number;
      osiKey?: string;
    };

const ID_KEY = "nova_etrade_ids_v1";
const ID_BASE = 10_000_000;

const byKey = new Map<string, number>();
const byId = new Map<number, Ref>();
let nextId = ID_BASE;

function refKey(ref: Ref): string {
  return ref.kind === "STK"
    ? `S:${ref.symbol}`
    : `O:${ref.underlying}:${ref.year}${String(ref.month).padStart(2, "0")}${String(ref.day).padStart(2, "0")}:${ref.right}:${ref.strike}`;
}

function loadIds() {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.parse(localStorage.getItem(ID_KEY) ?? "null");
    if (!raw?.refs) return;
    for (const [id, ref] of Object.entries(raw.refs as Record<string, Ref>)) {
      const n = Number(id);
      byId.set(n, ref);
      byKey.set(refKey(ref), n);
      if (n >= nextId) nextId = n + 1;
    }
  } catch {
    /* corrupt cache — start fresh */
  }
}
loadIds();

let savePending = false;
function saveIds() {
  if (typeof window === "undefined" || savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try {
      localStorage.setItem(ID_KEY, JSON.stringify({ refs: Object.fromEntries(byId) }));
    } catch {
      /* quota — the registry still works in memory for this session */
    }
  }, 250);
}

function idFor(ref: Ref): number {
  const key = refKey(ref);
  const existing = byKey.get(key);
  if (existing) return existing;
  const id = nextId++;
  byKey.set(key, id);
  byId.set(id, ref);
  saveIds();
  return id;
}

function refFor(id: number): Ref | null {
  return byId.get(id) ?? null;
}

function stockId(symbol: string): number {
  return idFor({ kind: "STK", symbol: symbol.trim().toUpperCase() });
}

/** Reverse a conid to a plain symbol (stocks) or the option's underlying. */
function symbolFor(id: number): string | null {
  const ref = refFor(id);
  if (!ref) return null;
  return ref.kind === "STK" ? ref.symbol : ref.underlying;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export interface AuthStatus {
  authenticated: boolean;
  connected: boolean;
  competing: boolean;
  /** E*TRADE-specific detail; the IBKR build had no equivalent. */
  state?: "DISCONNECTED" | "EXPIRED" | "INACTIVE" | "CONNECTED";
  etradeEnv?: "sandbox" | "production";
  etDay?: string | null;
  /** Synthetic bracket engine health — the Broker page warns loudly when this is unhealthy. */
  oco?: { healthy: boolean; active: number; staleMs: number; lastError: string | null };
}

interface ProxyStatus {
  state: "DISCONNECTED" | "EXPIRED" | "INACTIVE" | "CONNECTED";
  etradeEnv: "sandbox" | "production";
  accountIdKey: string | null;
  etDay: string | null;
  oco: { healthy: boolean; active: number; staleMs: number; lastError: string | null };
}

// STICKY STATUS: same trade-off the IBKR build made. A momentary blip (a renew in flight, a
// dropped request) must not flip the whole UI red; a real logout persists past the window.
let lastAuthOkAt = 0;

export async function getAuthStatus(): Promise<AuthStatus> {
  const sticky = Date.now() - lastAuthOkAt < 90_000;
  let st: ProxyStatus | null = null;
  try {
    st = await api<ProxyStatus>("/api/status");
  } catch {
    /* transient network error — treat like a blip */
  }

  if (st) adoptDetectedAccount(st.accountIdKey);

  const authenticated = st?.state === "CONNECTED";
  if (authenticated) lastAuthOkAt = Date.now();

  if (!authenticated && sticky && st?.state !== "EXPIRED" && st?.state !== "DISCONNECTED") {
    return {
      authenticated: true,
      connected: true,
      competing: false,
      state: st?.state,
      etradeEnv: st?.etradeEnv,
      etDay: st?.etDay ?? null,
      oco: st?.oco,
    };
  }

  return {
    authenticated,
    // INACTIVE means the token exists and is renewable — that is "connected but idle".
    connected: authenticated || st?.state === "INACTIVE",
    competing: false,
    state: st?.state ?? "DISCONNECTED",
    etradeEnv: st?.etradeEnv,
    etDay: st?.etDay ?? null,
    oco: st?.oco,
  };
}

/**
 * Reactivate a token idled past E*TRADE's 2h inactivity limit.
 * Throws like the IBKR tickle did, so existing error handling still fires.
 * Cannot revive a token that died at midnight ET — only a human can.
 */
export async function tickle() {
  return api<{ ok: boolean; state: string }>("/api/auth/renew", { method: "POST" });
}

/**
 * Make sure we have a usable broker session.
 * Returns false when a human must re-authorise (expired / never connected).
 */
export async function ensureSession(_force = false): Promise<boolean> {
  const st = await getAuthStatus();
  if (st.authenticated) return true;
  if (st.state === "INACTIVE") {
    try {
      await tickle();
      lastAuthOkAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Step 1 of the daily login: ask E*TRADE for a request token and get the URL the trader must
 * open. They approve there and E*TRADE shows them a 5-character verification code.
 */
export async function startAuth(): Promise<{ authorizeUrl: string }> {
  return api<{ authorizeUrl: string }>("/api/auth/start", { method: "POST" });
}

/** Step 2: exchange that code for the day's access token. */
export async function completeAuth(verifier: string) {
  const out = await api<{ ok: boolean; accounts: any[]; accountIdKey: string | null }>(
    "/api/auth/complete",
    { method: "POST", body: JSON.stringify({ verifier: verifier.trim() }) }
  );
  if (out.accountIdKey) adoptDetectedAccount(out.accountIdKey);
  lastAuthOkAt = Date.now();
  return out;
}

/** Revoke the token at E*TRADE and forget it locally. */
export async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  lastAuthOkAt = 0;
}

export async function listAccounts() {
  return api<Array<{ accountId: string; accountIdKey: string; accountName: string; accountStatus: string }>>(
    "/api/accounts"
  );
}

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Background keepalive. The proxy renews server-side every ~90 min regardless, so this is a
 * second line of defence and a way to notice an expiry promptly in an open tab.
 */
export function startSessionKeepalive(onRevived?: () => void) {
  if (keepaliveTimer || typeof window === "undefined") return;
  const ping = async () => {
    const st = await getAuthStatus().catch(() => null);
    if (st?.state === "INACTIVE") {
      const ok = await ensureSession(true).catch(() => false);
      if (ok) onRevived?.();
    }
  };
  keepaliveTimer = setInterval(ping, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/** Symbols → contract ids. No network call: E*TRADE trades by symbol. */
export async function resolveConids(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of new Set(symbols.map((x) => x.trim().toUpperCase()))) {
    if (s) out[s] = stockId(s);
  }
  return out;
}

export async function getConid(symbol: string): Promise<number | null> {
  const s = symbol.trim().toUpperCase();
  return s ? stockId(s) : null;
}

/** Free-text search for US symbols/companies (for the search bar). */
export async function searchSymbols(query: string) {
  const rows = await api<Array<{ symbol: string; description: string; type: string }>>(
    `/api/market/lookup/${encodeURIComponent(query)}`
  );
  return (rows ?? [])
    .filter((r) => r.symbol)
    .map((r) => ({
      conid: stockId(r.symbol),
      symbol: r.symbol.toUpperCase(),
      name: r.description || r.symbol,
      // E*TRADE's lookup returns an instrument type (EQ, INDEX, MF…), not an exchange.
      exchange: r.type ?? "",
    }));
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export async function getAccountSummary() {
  const b = await api<any>(`/api/accounts/${requireAccount()}/balance`);
  return {
    netLiquidation: num(b.netAccountValue),
    buyingPower: num(b.buyingPower),
    availableFunds: num(b.cash),
    // E*TRADE's balance response has no margin-requirement breakdown equivalent to IBKR's.
    // Report 0 rather than inventing a number — the UI shows these as plain figures.
    initMarginReq: 0,
    maintMarginReq: 0,
    excessLiquidity: num(b.cash),
    totalCash: num(b.cash),
    unrealizedPnl: num(b.totalUnrealizedGain),
    realizedPnl: 0,
  };
}

export interface Position {
  conid: number;
  symbol: string;
  name: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  marketValue: number;
  pnl: number;
  pnlPct: number;
  side: "LONG" | "SHORT";
  sector: string;
  assetClass: string;
}

export async function getPositions(): Promise<Position[]> {
  const raw = await api<any[]>(`/api/accounts/${requireAccount()}/portfolio`);
  return (raw ?? [])
    .filter((p) => num(p.quantity) !== 0)
    .map((p) => {
      const qty = num(p.quantity);
      const isLong = qty > 0;
      const avgCost = num(p.avgCost);
      const mktPrice = num(p.lastPrice);
      // For shorts a falling price is a GAIN — flip the sign so % matches P&L.
      const pnlPct =
        p.unrealizedPnlPct != null
          ? num(p.unrealizedPnlPct)
          : avgCost > 0
            ? (isLong ? 1 : -1) * ((mktPrice - avgCost) / avgCost) * 100
            : 0;

      const isOption = p.securityType === "OPTN";
      const prod = p.product ?? {};
      const conid = isOption
        ? idFor({
            kind: "OPT",
            underlying: String(prod.symbol ?? p.symbol).toUpperCase(),
            year: Number(prod.expiryYear) || 0,
            month: Number(prod.expiryMonth) || 0,
            day: Number(prod.expiryDay) || 0,
            right: prod.callPut === "PUT" ? "P" : "C",
            strike: num(prod.strikePrice),
          })
        : stockId(String(p.symbol));

      return {
        conid,
        symbol: String(p.symbol ?? "").toUpperCase(),
        name: String(p.symbol ?? ""),
        quantity: qty,
        entryPrice: avgCost,
        currentPrice: mktPrice,
        marketValue: num(p.marketValue),
        pnl: num(p.unrealizedPnl),
        pnlPct,
        side: isLong ? ("LONG" as const) : ("SHORT" as const),
        sector: "",
        assetClass: isOption ? "OPT" : "STK",
      };
    });
}

/** IBKR needed a cache-invalidate call after trading; E*TRADE's portfolio is not cached. */
export async function invalidatePositionsCache() {
  /* no-op — kept so call sites compile unchanged */
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus = "Working" | "Filled" | "Canceled" | "Rejected";

function mapStatus(s: string): OrderStatus {
  const v = String(s ?? "").toUpperCase();
  if (["OPEN", "PARTIAL", "CANCEL_REQUESTED", "OPEN_ORDER"].includes(v)) return "Working";
  if (v === "EXECUTED") return "Filled";
  if (["CANCELLED", "CANCELED", "EXPIRED"].includes(v)) return "Canceled";
  return "Rejected";
}

export async function getOrders() {
  const raw = await api<any[]>(`/api/accounts/${requireAccount()}/orders?count=100`);
  return (raw ?? []).map((o) => {
    const sym = String(o.symbol ?? "").toUpperCase();
    const isOption = o.securityType === "OPTN";
    const prod = o.product ?? {};
    return {
      orderId: String(o.orderId),
      conid: isOption
        ? idFor({
            kind: "OPT",
            underlying: String(prod.symbol ?? sym).toUpperCase(),
            year: Number(prod.expiryYear) || 0,
            month: Number(prod.expiryMonth) || 0,
            day: Number(prod.expiryDay) || 0,
            right: prod.callPut === "PUT" ? "P" : "C",
            strike: num(prod.strikePrice),
          })
        : stockId(sym),
      symbol: sym,
      side: /^(BUY|BUY_TO_COVER|BUY_OPEN|BUY_CLOSE)$/.test(String(o.action)) ? "BUY" : "SELL",
      type: String(o.priceType ?? ""),
      quantity: num(o.quantity),
      filled: num(o.filledQuantity),
      // Stop orders keep their trigger in stopPrice, limits in limitPrice.
      price: num(o.limitPrice) || num(o.stopPrice) || num(o.avgExecutionPrice),
      status: mapStatus(o.status),
      rawStatus: String(o.status ?? ""),
      tif: String(o.orderTerm ?? ""),
      avgPrice: num(o.avgExecutionPrice),
      timeMs: Number(o.executedTime) || Number(o.placedTime) || 0,
      time: new Date(Number(o.executedTime) || Number(o.placedTime) || Date.now()).toLocaleTimeString(
        "en-US",
        { hour: "2-digit", minute: "2-digit" }
      ),
    };
  });
}

export interface PlaceOrderParams {
  symbol: string;
  /** Trade this exact contract (e.g. an option conid) instead of the plain stock symbol. */
  conid?: number;
  side: "BUY" | "SELL";
  quantity: number;
  /** MIT = Market-If-Touched. E*TRADE has no MIT, so it is placed as a broker-held STOP,
   *  which has the same trigger-then-market behaviour and survives a server outage. */
  orderType: "MKT" | "LMT" | "STP" | "MIT";
  /** Limit price (LMT) or trigger price (STP / MIT). */
  price?: number;
  /** Optional bracket: fixed stop-loss trigger for the opposite side. */
  stopLoss?: number;
  /** Optional bracket: TRAILING stop-loss as a percent. Placed as a real broker-held
   *  TRAILING_STOP_PRCT order once the entry fills. Takes precedence over stopLoss. */
  trailingStopPct?: number;
  /** Optional bracket: take-profit limit for the opposite side. */
  takeProfit?: number;
  tif?: "DAY" | "GTC";
  /** Allow execution outside regular hours. LIMIT only — E*TRADE, like IBKR, rejects
   *  market orders outside RTH. */
  outsideRth?: boolean;
}

const PRICE_TYPE: Record<PlaceOrderParams["orderType"], string> = {
  MKT: "MARKET",
  LMT: "LIMIT",
  STP: "STOP",
  MIT: "STOP",
};

export async function placeOrder(params: PlaceOrderParams) {
  const { symbol, side, quantity, orderType, price, stopLoss, trailingStopPct, takeProfit } = params;
  if (!quantity || quantity <= 0) throw new Error("Quantity must be positive");
  if (orderType !== "MKT" && !price) throw new Error(`${orderType} orders need a price`);
  if (params.outsideRth && orderType === "MKT") {
    throw new Error("Market orders are not accepted outside regular hours — use a limit order");
  }

  const account = requireAccount();
  const ref = params.conid ? refFor(params.conid) : null;
  const isOption = ref?.kind === "OPT";

  const spec: Record<string, unknown> = {
    symbol: isOption ? ref.underlying : symbol.trim().toUpperCase(),
    securityType: isOption ? "OPTN" : "EQ",
    quantity,
    priceType: PRICE_TYPE[orderType],
    orderTerm: params.tif === "DAY" ? "GOOD_FOR_DAY" : "GOOD_UNTIL_CANCEL",
    marketSession: params.outsideRth ? "EXTENDED" : "REGULAR",
  };

  if (isOption) {
    Object.assign(spec, {
      underlying: ref.underlying,
      callPut: ref.right === "P" ? "PUT" : "CALL",
      expiryYear: ref.year,
      expiryMonth: ref.month,
      expiryDay: ref.day,
      strikePrice: ref.strike,
      // Options open/close semantics: the app only ever buys to open and sells to close.
      action: side === "BUY" ? "BUY_OPEN" : "SELL_CLOSE",
    });
  } else {
    spec.action = side;
  }

  if (orderType === "LMT") spec.limitPrice = price;
  if (orderType === "STP" || orderType === "MIT") spec.stopPrice = price;

  // Brackets: the stop (or trailing stop) becomes a REAL broker order once the entry fills;
  // the take-profit is watched by the proxy. See oco-watcher.cjs for why that split.
  if (trailingStopPct || stopLoss || takeProfit) {
    spec.bracket = {
      ...(trailingStopPct ? { trailingPercent: trailingStopPct } : {}),
      ...(!trailingStopPct && stopLoss ? { stopPrice: stopLoss } : {}),
      ...(takeProfit ? { targetPrice: takeProfit } : {}),
    };
  }

  const out = await api<any>(`/api/accounts/${account}/orders/submit`, {
    method: "POST",
    body: JSON.stringify(spec),
  });

  if (!out.orderId) throw new Error(out.warning || "E*TRADE returned no order id — treat as NOT placed");
  if (out.warning) console.warn("[etrade] order warning:", out.warning);

  return {
    orderId: String(out.orderId),
    status: (out.order?.status ?? (out.verified ? "Submitted" : "Unverified")) as string,
  };
}

/**
 * Post-submit verification. Carried over from the IBKR build verbatim in spirit: a broker
 * acknowledgement is not proof the order exists, so poll the real order book.
 * Returns the raw broker status, or null if it never appeared.
 */
export async function verifyOrderLive(orderId: string, tries = 6): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const orders = await getOrders().catch(() => [] as Awaited<ReturnType<typeof getOrders>>);
    const o = orders.find((x) => String(x.orderId) === String(orderId));
    if (o) return o.rawStatus;
  }
  return null;
}

/**
 * Cancel every WORKING order matching the symbol and/or conid, and drop any synthetic
 * brackets on it. Crucial before manually closing a position: a leftover stop or take-profit
 * executes later and flips you into an unintended short.
 */
export async function cancelWorkingOrders(filter: { symbol?: string; conid?: number }) {
  const wantSymbol = filter.symbol?.toUpperCase();
  const orders = await getOrders().catch(() => []);
  const targets = orders.filter(
    (o) =>
      o.status === "Working" &&
      ((filter.conid != null && o.conid === filter.conid) ||
        (wantSymbol && o.symbol?.toUpperCase() === wantSymbol))
  );

  let cancelled = 0;
  for (const o of targets) {
    try {
      await cancelOrder(String(o.orderId));
      cancelled++;
    } catch {
      /* keep going — closing the position matters more */
    }
  }

  // Synthetic brackets live in the proxy, not in the order book.
  const symbol = wantSymbol ?? (filter.conid != null ? symbolFor(filter.conid) : null);
  if (symbol) {
    try {
      const { brackets } = await api<{ brackets: Array<{ id: string; symbol: string; state: string }> }>(
        "/api/brackets"
      );
      await Promise.all(
        (brackets ?? [])
          .filter((b) => b.symbol?.toUpperCase() === symbol && b.state !== "DONE")
          .map((b) => api(`/api/brackets/${encodeURIComponent(b.id)}`, { method: "DELETE" }).catch(() => null))
      );
    } catch {
      /* non-fatal */
    }
  }

  return cancelled;
}

export async function closePosition(conid: number, quantity: number) {
  if (!quantity) throw new Error("Nothing to close");
  const account = requireAccount();
  const ref = refFor(conid);
  if (!ref) throw new Error("Unknown contract — refresh positions and retry");

  // Kill any working orders on this contract first (see cancelWorkingOrders).
  await cancelWorkingOrders({ conid }).catch(() => {});

  const isOption = ref.kind === "OPT";
  const spec: Record<string, unknown> = {
    symbol: isOption ? ref.underlying : ref.symbol,
    securityType: isOption ? "OPTN" : "EQ",
    quantity: Math.abs(quantity),
    priceType: "MARKET",
    orderTerm: "GOOD_FOR_DAY",
    marketSession: "REGULAR",
    action: isOption
      ? quantity > 0
        ? "SELL_CLOSE"
        : "BUY_CLOSE"
      : quantity > 0
        ? "SELL"
        : "BUY_TO_COVER",
  };
  if (isOption) {
    Object.assign(spec, {
      underlying: ref.underlying,
      callPut: ref.right === "P" ? "PUT" : "CALL",
      expiryYear: ref.year,
      expiryMonth: ref.month,
      expiryDay: ref.day,
      strikePrice: ref.strike,
    });
  }

  const out = await api<any>(`/api/accounts/${account}/orders/submit`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
  if (!out.orderId) throw new Error(out.warning || "Close order was not accepted");
  return { orderId: String(out.orderId), status: out.verified ? "Submitted" : "Unverified" };
}

export interface Trade {
  executionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  time: number;
  commission: number;
  netAmount: number;
  orderRef: string;
}

/** Executed trades for the last few days. */
export async function getTrades(days = 6): Promise<Trade[]> {
  const raw = await api<any[]>(`/api/accounts/${requireAccount()}/transactions?days=${days}`);
  return (raw ?? []).map((t) => ({
    executionId: String(t.transactionId ?? ""),
    symbol: String(t.symbol ?? "").toUpperCase(),
    side: num(t.quantity) >= 0 ? ("BUY" as const) : ("SELL" as const),
    quantity: Math.abs(num(t.quantity)),
    price: num(t.price),
    time: Number(t.transactionDate) || 0,
    commission: num(t.commission),
    netAmount: num(t.netAmount),
    orderRef: String(t.orderNo ?? ""),
  }));
}

export async function cancelOrder(orderId: string) {
  return api<any>(`/api/accounts/${requireAccount()}/orders/cancel`, {
    method: "PUT",
    body: JSON.stringify({ orderId }),
  });
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface Snapshot {
  conid: number;
  symbol: string;
  last: number;
  change: number;
  changePct: number;
  bid: number;
  ask: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  volume: number;
  updated: number;
}

export interface SymbolQuote extends Snapshot {
  symbol: string;
}

// PERSISTENT LAST PRICE: a refetch that comes back empty (a blip, a rate-limit pause) must
// never snap a card back to zero or to an older number. Carried over from the IBKR build.
const lastGood = new Map<string, SymbolQuote>();

/** Live quotes for a list of symbols. */
export async function getQuotes(symbols: string[]): Promise<SymbolQuote[]> {
  const list = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
  if (!list.length) return [];

  let rows: any[] = [];
  try {
    rows = await api<any[]>(`/api/market/quote?symbols=${encodeURIComponent(list.join(","))}`);
  } catch (error) {
    console.warn("Quotes failed:", error);
    return list.map((s) => lastGood.get(s)).filter((q): q is SymbolQuote => !!q);
  }

  const fresh = new Map<string, any>();
  for (const r of rows ?? []) fresh.set(String(r.symbol ?? "").toUpperCase(), r);

  const out: SymbolQuote[] = [];
  for (const sym of list) {
    const r = fresh.get(sym);
    if (r && num(r.last) > 0) {
      const q: SymbolQuote = {
        conid: stockId(sym),
        symbol: sym,
        last: num(r.last),
        change: num(r.change),
        changePct: num(r.changePct),
        bid: num(r.bid),
        ask: num(r.ask),
        high: num(r.high),
        low: num(r.low),
        open: num(r.open),
        prevClose: num(r.prevClose) || (num(r.last) && num(r.change) ? num(r.last) - num(r.change) : 0),
        volume: num(r.volume),
        updated: Number(r.dateTimeUTC) ? Number(r.dateTimeUTC) * 1000 : Date.now(),
      };
      lastGood.set(sym, q);
      out.push(q);
    } else {
      const prev = lastGood.get(sym);
      if (prev) out.push(prev);
    }
  }
  return out;
}

export async function getMarketSnapshot(conids: number[]): Promise<Snapshot[]> {
  const symbols = conids.map((id) => symbolFor(id)).filter((s): s is string => !!s);
  return getQuotes(symbols);
}

export interface ChartBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  time: string;
}

/**
 * E*TRADE has no candle endpoint, so history comes from the proxy's chart route
 * (consolidated-tape data, server-side). Period/bar strings keep the IBKR spelling
 * so call sites are unchanged.
 */
export async function getChartData(conid: number, period = "1d", bar = "5min"): Promise<ChartBar[]> {
  const symbol = symbolFor(conid);
  if (!symbol) return [];
  try {
    const data = await api<Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>>(
      `/api/market/chart?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&bar=${encodeURIComponent(bar)}`
    );
    return (data ?? []).map((d) => ({
      t: d.t,
      o: num(d.o),
      h: num(d.h),
      l: num(d.l),
      c: num(d.c),
      v: num(d.v),
      time: new Date(d.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    }));
  } catch (error) {
    console.warn("Chart data failed:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Options (F&O)
// ---------------------------------------------------------------------------

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** 2026, 7 → "JUL26" (the month key format the options UI already uses). */
function monthKey(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? "JAN"}${String(year).slice(-2)}`;
}

function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^([A-Z]{3})(\d{2})$/.exec(key.trim().toUpperCase());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]) + 1;
  if (!month) return null;
  return { year: 2000 + Number(m[2]), month };
}

export interface OptionMeta {
  conid: number;
  months: string[]; // e.g. ["JUL26","AUG26",...]
}

type Expiry = { year: number; month: number; day: number };

const expiryCache = new Map<string, Expiry[]>();

async function expirations(symbol: string): Promise<Expiry[]> {
  const sym = symbol.trim().toUpperCase();
  const cached = expiryCache.get(sym);
  if (cached) return cached;
  const rows = await api<Expiry[]>(`/api/market/optionexpiredates?symbol=${encodeURIComponent(sym)}`);
  const list = (rows ?? [])
    .filter((e) => e.year && e.month && e.day)
    .sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day);
  expiryCache.set(sym, list);
  return list;
}

/** Underlying contract id + available option months for a stock/ETF symbol. */
export async function getOptionMeta(symbol: string): Promise<OptionMeta | null> {
  const sym = symbol.trim().toUpperCase();
  try {
    const list = await expirations(sym);
    if (!list.length) return null;
    const months = [...new Set(list.map((e) => monthKey(e.year, e.month)))];
    return { conid: stockId(sym), months };
  } catch {
    return null;
  }
}

export interface OptionContract {
  conid: number;
  strike: number;
  right: "C" | "P";
  maturityDate: string; // YYYYMMDD
}

function ymd(e: Expiry): string {
  return `${e.year}${String(e.month).padStart(2, "0")}${String(e.day).padStart(2, "0")}`;
}

const chainCache = new Map<string, any[]>();

async function chainFor(symbol: string, e: Expiry, near?: number, strikes = 40): Promise<any[]> {
  const key = `${symbol}:${ymd(e)}:${near ?? ""}:${strikes}`;
  const hit = chainCache.get(key);
  if (hit) return hit;
  const pairs = await api<any[]>(
    `/api/market/optionchains?symbol=${encodeURIComponent(symbol)}&expiryYear=${e.year}` +
      `&expiryMonth=${e.month}&expiryDay=${e.day}&noOfStrikes=${strikes}&chainType=CALLPUT` +
      (near != null && near > 0 ? `&strikePriceNear=${Math.round(near)}` : "")
  );
  chainCache.set(key, pairs ?? []);
  return pairs ?? [];
}

/** All listed strikes for one option month. */
export async function getOptionStrikes(conid: number, month: string): Promise<number[]> {
  const symbol = symbolFor(conid);
  const parsed = parseMonthKey(month);
  if (!symbol || !parsed) return [];
  const list = (await expirations(symbol)).filter(
    (e) => e.year === parsed.year && e.month === parsed.month
  );
  if (!list.length) return [];

  // Use the last expiry in the month (the standard monthly) for the strike ladder — weeklies
  // inside the month list the same strikes.
  const pairs = await chainFor(symbol, list[list.length - 1], 0, 60);
  const strikes = new Set<number>();
  for (const p of pairs) {
    const k = num(p.call?.strikePrice ?? p.put?.strikePrice);
    if (k > 0) strikes.add(k);
  }
  return [...strikes].sort((a, b) => a - b);
}

/** The `span·2+1` strikes nearest `spot` (or the middle of the list if spot=0). */
export function pickNearestStrikes(all: number[], spot: number, span = 6): number[] {
  if (!all.length) return [];
  if (spot <= 0) {
    const mid = Math.floor(all.length / 2);
    return all.slice(Math.max(0, mid - span), mid + span + 1);
  }
  return [
    ...new Set([...all].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, span * 2 + 1)),
  ].sort((a, b) => a - b);
}

/** Call+put contract ids for the requested strikes of one month (weeklies included). */
export async function resolveOptionContracts(
  conid: number,
  month: string,
  strikes: number[]
): Promise<OptionContract[]> {
  const symbol = symbolFor(conid);
  const parsed = parseMonthKey(month);
  if (!symbol || !parsed || !strikes.length) return [];

  const list = (await expirations(symbol)).filter(
    (e) => e.year === parsed.year && e.month === parsed.month
  );
  const wanted = new Set(strikes.map((k) => Number(k)));
  const mid = strikes[Math.floor(strikes.length / 2)];
  const out: OptionContract[] = [];

  for (const e of list) {
    const pairs = await chainFor(symbol, e, mid, Math.max(20, strikes.length + 6)).catch(() => []);
    for (const p of pairs) {
      for (const [leg, right] of [
        [p.call, "C"],
        [p.put, "P"],
      ] as const) {
        if (!leg) continue;
        const strike = num(leg.strikePrice);
        if (!wanted.has(strike)) continue;
        out.push({
          conid: idFor({
            kind: "OPT",
            underlying: symbol,
            year: e.year,
            month: e.month,
            day: e.day,
            right,
            strike,
            osiKey: leg.osiKey,
          }),
          strike,
          right,
          maturityDate: ymd(e),
        });
      }
    }
  }
  return out;
}

/** Option chain for one month: nearest strikes plus their contract ids. */
export async function getOptionChain(
  underlying: number,
  month: string,
  spot: number,
  span = 6
): Promise<{ strikes: number[]; contracts: OptionContract[] }> {
  const all = await getOptionStrikes(underlying, month);
  if (!all.length) return { strikes: [], contracts: [] };
  const picked = pickNearestStrikes(all, spot, span);
  const contracts = await resolveOptionContracts(underlying, month, picked);
  return { strikes: picked, contracts };
}

/**
 * Pick the single best option contract to express a directional signal: the strike just
 * in-the-money, with an expiry 7–35 days out (enough time to be right, not bleeding theta).
 */
export async function findOptionPlay(
  symbol: string,
  right: "C" | "P",
  spot: number
): Promise<(OptionContract & { underlyingConid: number }) | null> {
  const sym = symbol.trim().toUpperCase();
  if (spot <= 0) return null;
  try {
    const now = Date.now();
    const list = (await expirations(sym))
      .map((e) => ({
        e,
        days: (Date.parse(`${e.year}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}T21:00:00Z`) - now) / 86_400_000,
      }))
      .filter((x) => x.days >= 7 && x.days <= 35)
      .sort((a, b) => a.days - b.days);
    if (!list.length) return null;

    for (const { e } of list.slice(0, 2)) {
      const pairs = await chainFor(sym, e, spot, 20).catch(() => []);
      const strikes = pairs
        .map((p) => num(p.call?.strikePrice ?? p.put?.strikePrice))
        .filter((k) => k > 0);
      if (!strikes.length) continue;

      const itm =
        right === "C"
          ? strikes.filter((k) => k <= spot).sort((a, b) => b - a)[0]
          : strikes.filter((k) => k >= spot).sort((a, b) => a - b)[0];
      const strike = itm ?? strikes.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
      const pair = pairs.find((p) => num(p.call?.strikePrice ?? p.put?.strikePrice) === strike);
      const leg = right === "C" ? pair?.call : pair?.put;
      if (!leg) continue;

      return {
        conid: idFor({
          kind: "OPT",
          underlying: sym,
          year: e.year,
          month: e.month,
          day: e.day,
          right,
          strike,
          osiKey: leg.osiKey,
        }),
        strike,
        right,
        maturityDate: ymd(e),
        underlyingConid: stockId(sym),
      };
    }
  } catch {
    /* no play available */
  }
  return null;
}

export interface OptionQuote {
  conid: number;
  last: number;
  bid: number;
  ask: number;
  changePct: number;
  volume: number;
  iv: number; // implied volatility %
  delta: number;
  theta: number;
}

/**
 * Live quotes + greeks for option contract ids.
 * Sourced from the chain endpoint (which already carries bid/ask/last/volume/greeks), so one
 * round-trip serves every strike of the same expiry.
 */
export async function getOptionQuotes(conids: number[]): Promise<OptionQuote[]> {
  if (!conids.length) return [];

  // Group by (underlying, expiry) so each chain is fetched once.
  const groups = new Map<string, { underlying: string; e: Expiry; ids: number[] }>();
  for (const id of conids) {
    const ref = refFor(id);
    if (ref?.kind !== "OPT") continue;
    const key = `${ref.underlying}:${ref.year}-${ref.month}-${ref.day}`;
    const g = groups.get(key) ?? {
      underlying: ref.underlying,
      e: { year: ref.year, month: ref.month, day: ref.day },
      ids: [],
    };
    g.ids.push(id);
    groups.set(key, g);
  }

  const out: OptionQuote[] = [];
  for (const g of groups.values()) {
    const strikes = g.ids
      .map((id) => {
        const r = refFor(id);
        return r?.kind === "OPT" ? r.strike : 0;
      })
      .filter((k) => k > 0);
    const near = strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0;

    // A fresh read every time — the cache is for contract discovery, not for prices.
    const key = `${g.underlying}:${ymd(g.e)}:${near}:${Math.max(20, strikes.length + 6)}`;
    chainCache.delete(key);
    const pairs = await chainFor(g.underlying, g.e, near, Math.max(20, strikes.length + 6)).catch(() => []);

    for (const id of g.ids) {
      const ref = refFor(id);
      if (ref?.kind !== "OPT") continue;
      const pair = pairs.find((p) => num(p.call?.strikePrice ?? p.put?.strikePrice) === ref.strike);
      const leg = ref.right === "C" ? pair?.call : pair?.put;
      if (!leg) continue;
      const greeks = leg.OptionGreeks ?? {};
      out.push({
        conid: id,
        last: num(leg.lastPrice),
        bid: num(leg.bid),
        ask: num(leg.ask),
        // E*TRADE gives netChange, not a percent — derive it against the prior price.
        changePct:
          num(leg.lastPrice) - num(leg.netChange) > 0
            ? (num(leg.netChange) / (num(leg.lastPrice) - num(leg.netChange))) * 100
            : 0,
        volume: num(leg.volume),
        iv: num(greeks.iv) * (num(greeks.iv) < 5 ? 100 : 1), // normalise 0.42 vs 42
        delta: num(greeks.delta),
        theta: num(greeks.theta),
      });
    }
  }
  return out;
}
