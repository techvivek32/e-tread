/**
 * OAuth 1.0a (HMAC-SHA1) signer for the E*TRADE API.
 *
 * E*TRADE does NOT use OAuth 2.0 and ships no official Node SDK, so this is hand-rolled
 * against RFC 5849. Node built-ins only — no dependency to audit or keep patched.
 *
 * Quirks handled here (each one cost time to find in other people's broken clients):
 *  - RFC3986 percent-encoding: encodeURIComponent leaves ! ' ( ) * alone; OAuth requires them encoded.
 *  - Only QUERY params are signed. JSON bodies are not form-encoded, so they stay out of the
 *    signature base string (correct per spec — signing them produces 401s).
 *  - realm="" must be present in the Authorization header but MUST NOT enter the signature.
 *  - request_token / access_token responses come back form-encoded, not JSON.
 */

'use strict';

const crypto = require('crypto');

/** RFC3986 percent-encoding (stricter than encodeURIComponent). */
function enc(v) {
  return encodeURIComponent(String(v == null ? '' : v)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function timestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Build the signature base string.
 * @param {string} method   HTTP verb
 * @param {string} url      absolute URL WITHOUT query string
 * @param {object} params   oauth_* params merged with query params (no body params)
 */
function baseString(method, url, params) {
  const normalized = Object.keys(params)
    .map((k) => [enc(k), enc(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return `${method.toUpperCase()}&${enc(url)}&${enc(normalized)}`;
}

function sign(base, consumerSecret, tokenSecret) {
  const key = `${enc(consumerSecret)}&${enc(tokenSecret || '')}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

/**
 * Produce the Authorization header value for one request.
 *
 * @param {object}  o
 * @param {string}  o.method
 * @param {string}  o.url            absolute URL; a query string here is parsed and signed
 * @param {string}  o.consumerKey
 * @param {string}  o.consumerSecret
 * @param {string} [o.token]         request token or access token
 * @param {string} [o.tokenSecret]
 * @param {object} [o.extra]         e.g. { oauth_callback: 'oob' } or { oauth_verifier: 'ABC12' }
 * @returns {string} "OAuth realm=\"\", oauth_consumer_key=..., ..."
 */
function authHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret, extra }) {
  const u = new URL(url);
  const query = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp(),
    oauth_version: '1.0',
    ...(token ? { oauth_token: token } : {}),
    ...(extra || {}),
  };

  const bareUrl = `${u.origin}${u.pathname}`;
  const signature = sign(baseString(method, bareUrl, { ...oauth, ...query }), consumerSecret, tokenSecret);

  // realm is in the header but never in the signature.
  const parts = Object.keys({ ...oauth, oauth_signature: signature })
    .sort()
    .map((k) => `${enc(k)}="${enc(k === 'oauth_signature' ? signature : oauth[k])}"`);

  return `OAuth realm="", ${parts.join(', ')}`;
}

/** Parse a form-encoded OAuth response body (`oauth_token=..&oauth_token_secret=..`). */
function parseTokenResponse(body) {
  const out = {};
  String(body)
    .trim()
    .split('&')
    .filter(Boolean)
    .forEach((pair) => {
      const i = pair.indexOf('=');
      if (i === -1) return;
      out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
  return out;
}

module.exports = { enc, authHeader, parseTokenResponse, baseString, sign };
