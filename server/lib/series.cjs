/**
 * Intraday price series, recorded from E*TRADE's own quotes.
 *
 * E*TRADE has no candle or history endpoint — not a delayed one, not a paid one. The API is
 * quotes, lookup, option chains, accounts and orders, and that is all. So a chart on this
 * terminal can come from exactly two places: a third-party feed, or E*TRADE quotes we keep
 * ourselves. This file is the second option.
 *
 * Every quote the proxy serves is also written here, bucketed into candles. What you see on a
 * chart is therefore the same data the order desk is pricing from — no second source that can
 * disagree with the broker at the moment it matters.
 *
 * The honest limitation, which the UI states rather than hides: the series starts when this
 * process started. There is no back-history and there cannot be. A restart loses it, by design
 * — persisting it would invite treating it as a record, and it is not one.
 */

'use strict';

const BUCKET_MS = 60_000;      // one candle per minute
const MAX_BUCKETS = 720;       // ~12h — a full session plus extended hours
const MAX_SYMBOLS = 300;       // bounded so a runaway watchlist cannot eat memory

/** symbol -> { buckets: Map<bucketStart, candle>, lastSeen } */
const store = new Map();

function evictIfNeeded() {
  if (store.size <= MAX_SYMBOLS) return;
  // Drop whichever symbols have been quiet longest.
  const stale = [...store.entries()]
    .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    .slice(0, store.size - MAX_SYMBOLS);
  stale.forEach(([sym]) => store.delete(sym));
}

/**
 * Fold one quote into the series. Called for every quote the proxy serves, so the chart is a
 * by-product of normal traffic rather than extra polling.
 *
 * @param {{symbol:string, last:number|null, volume:number|null, dateTimeUTC:number|null}} q
 */
function record(q) {
  const symbol = String(q?.symbol || '').toUpperCase();
  const price = Number(q?.last);
  if (!symbol || !Number.isFinite(price) || price <= 0) return; // no price, nothing to plot

  // Prefer the broker's own timestamp; fall back to arrival time.
  const ts = Number(q.dateTimeUTC) ? Number(q.dateTimeUTC) * 1000 : Date.now();
  const start = Math.floor(ts / BUCKET_MS) * BUCKET_MS;

  let entry = store.get(symbol);
  if (!entry) {
    entry = { buckets: new Map(), lastSeen: 0 };
    store.set(symbol, entry);
    evictIfNeeded();
  }
  entry.lastSeen = Date.now();

  const candle = entry.buckets.get(start);
  if (!candle) {
    entry.buckets.set(start, {
      t: start,
      o: price,
      h: price,
      l: price,
      c: price,
      v: Number(q.volume) || 0,
      n: 1,
    });
    // Ring-buffer the oldest out.
    if (entry.buckets.size > MAX_BUCKETS) {
      const oldest = entry.buckets.keys().next().value;
      entry.buckets.delete(oldest);
    }
    return;
  }

  candle.c = price;
  if (price > candle.h) candle.h = price;
  if (price < candle.l) candle.l = price;
  candle.n += 1;
  // Volume is cumulative for the day in E*TRADE's payload, so take the latest rather than sum.
  const vol = Number(q.volume);
  if (Number.isFinite(vol) && vol > 0) candle.v = vol;
}

/** Fold a whole batch — the shape getQuotes() returns. */
function recordAll(quotes) {
  if (!Array.isArray(quotes)) return;
  quotes.forEach(record);
}

/**
 * @returns {{symbol:string, candles:Array, since:number|null, coverageMs:number, source:string}}
 */
function series(symbol, { limit = MAX_BUCKETS } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const entry = store.get(sym);
  const candles = entry ? [...entry.buckets.values()].sort((a, b) => a.t - b.t).slice(-limit) : [];

  return {
    symbol: sym,
    candles,
    since: candles.length ? candles[0].t : null,
    coverageMs: candles.length ? candles[candles.length - 1].t - candles[0].t : 0,
    // The UI shows this verbatim, so it cannot be mistaken for exchange history.
    source: 'E*TRADE quotes, recorded live by this server',
  };
}

function stats() {
  return {
    symbols: store.size,
    candles: [...store.values()].reduce((n, e) => n + e.buckets.size, 0),
    bucketMs: BUCKET_MS,
  };
}

module.exports = { record, recordAll, series, stats, BUCKET_MS };
