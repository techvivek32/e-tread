/**
 * Historical candles for the chart UI.
 *
 * E*TRADE's API has no candle/history endpoint at all — the IBKR build used
 * /iserver/marketdata/history, which has no counterpart here. So history comes from the
 * consolidated tape, fetched SERVER-SIDE (never from the browser, which would be blocked
 * by CORS and would leak the request pattern to the client).
 *
 * This is display data only. Execution decisions use E*TRADE's own quotes — a free
 * historical feed can freeze or lag by minutes, and that lesson was paid for once already.
 */

'use strict';

const HOST = 'https://query1.finance.yahoo.com';

// The UI speaks IBKR's period/bar spelling; translate rather than change 20 call sites.
const RANGE = {
  '1d': '1d',
  '2d': '5d',
  '1w': '5d',
  '5d': '5d',
  '1m': '1mo',
  '3m': '3mo',
  '6m': '6mo',
  '1y': '1y',
  '2y': '2y',
  '5y': '5y',
};

const INTERVAL = {
  '1min': '1m',
  '2min': '2m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1h': '60m',
  '1hour': '60m',
  '1d': '1d',
  '1day': '1d',
  '1w': '1wk',
};

/**
 * @param {string} symbol
 * @param {string} period  IBKR-style: 1d, 1w, 1m, 1y…
 * @param {string} bar     IBKR-style: 1min, 5min, 15min, 1h, 1d…
 * @returns {Promise<Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>}
 */
async function getCandles(symbol, period = '1d', bar = '5min') {
  const range = RANGE[String(period).toLowerCase()] || '1d';
  const interval = INTERVAL[String(bar).toLowerCase()] || '5m';

  const url =
    `${HOST}/v8/finance/chart/${encodeURIComponent(String(symbol).toUpperCase())}` +
    `?range=${range}&interval=${interval}&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      // A plain fetch with no UA gets rejected.
      'User-Agent': 'Mozilla/5.0 (compatible; NOVA/1.0)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`chart source ${res.status}`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'no chart data');

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const out = [];

  for (let i = 0; i < ts.length; i += 1) {
    const c = q.close?.[i];
    // Gaps come back as nulls. Drop them rather than drawing a candle at zero.
    if (c == null) continue;
    out.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? c,
      h: q.high?.[i] ?? c,
      l: q.low?.[i] ?? c,
      c,
      v: q.volume?.[i] ?? 0,
    });
  }
  return out;
}

module.exports = { getCandles };
