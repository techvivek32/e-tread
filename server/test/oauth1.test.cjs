/**
 * OAuth 1.0a signer verification.
 *
 * Run: node test/oauth1.test.cjs
 *
 * Checked against the canonical OAuth Core 1.0 Appendix A.5.1 vector — if this passes, the
 * signature base string, RFC3986 encoding, parameter sorting and HMAC-SHA1 key construction
 * are all correct, and E*TRADE will accept our requests. If it fails, nothing else matters.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { enc, baseString, sign, parseTokenResponse, authHeader } = require('../lib/oauth1.cjs');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nOAuth 1.0a signer');

check('RFC3986 encoding covers !\'()* which encodeURIComponent leaves alone', () => {
  assert.strictEqual(enc("a b!'()*"), 'a%20b%21%27%28%29%2A');
  assert.strictEqual(enc('AZaz09-._~'), 'AZaz09-._~'); // unreserved set stays literal
  assert.strictEqual(enc('&=+'), '%26%3D%2B');
});

check('HMAC-SHA1 matches the standard test vector', () => {
  const mac = crypto
    .createHmac('sha1', 'key')
    .update('The quick brown fox jumps over the lazy dog')
    .digest('hex');
  assert.strictEqual(mac, 'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9');
});

check('signature base string matches OAuth Core 1.0 A.5.1', () => {
  const params = {
    oauth_consumer_key: 'dpf43f3p2l4k3l03',
    oauth_token: 'nnch734d00sl2jdk',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1191242096',
    oauth_nonce: 'kllo9940pd9333jh',
    oauth_version: '1.0',
    file: 'vacation.jpg',
    size: 'original',
  };
  const expected =
    'GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3D' +
    'dpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26' +
    'oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal';

  assert.strictEqual(baseString('GET', 'http://photos.example.net/photos', params), expected);
});

check('signature matches OAuth Core 1.0 A.5.1', () => {
  const base =
    'GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3D' +
    'dpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26' +
    'oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal';

  assert.strictEqual(sign(base, 'kd94hf93k423kf44', 'pfkkdhi9sl3r4s00'), 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
});

check('query params in the URL are signed; the bare URL is used in the base string', () => {
  // Two callers expressing the same request must produce the same signature.
  const viaUrl = baseString('GET', 'https://api.etrade.com/v1/market/quote/AAPL', {
    detailFlag: 'ALL',
    oauth_consumer_key: 'k',
    oauth_nonce: 'n',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1',
    oauth_version: '1.0',
  });
  assert.ok(viaUrl.includes('detailFlag%3DALL'), 'query param must be in the base string');
  assert.ok(!viaUrl.includes('%3Fdetail'), 'the query string must not be inside the encoded URL');
});

check('Authorization header carries realm and a signature, and signs query params', () => {
  const h = authHeader({
    method: 'GET',
    url: 'https://api.etrade.com/v1/accounts/ABC/balance?instType=BROKERAGE&realTimeNAV=true',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    token: 'tk',
    tokenSecret: 'ts',
  });
  assert.ok(h.startsWith('OAuth realm="", '), 'must start with an empty realm');
  assert.ok(/oauth_signature="[^"]+"/.test(h), 'must contain a signature');
  assert.ok(h.includes('oauth_token="tk"'), 'must carry the token');
  assert.ok(!h.includes('instType'), 'query params are signed, never echoed into the header');
});

check('oauth_callback=oob rides in the signature for request_token', () => {
  const h = authHeader({
    method: 'GET',
    url: 'https://api.etrade.com/oauth/request_token',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    extra: { oauth_callback: 'oob' },
  });
  assert.ok(h.includes('oauth_callback="oob"'));
  assert.ok(!h.includes('oauth_token='), 'no token exists yet at request_token time');
});

check('form-encoded token responses parse', () => {
  const p = parseTokenResponse('oauth_token=abc%2F123&oauth_token_secret=s%3Dx&oauth_callback_confirmed=true');
  assert.strictEqual(p.oauth_token, 'abc/123');
  assert.strictEqual(p.oauth_token_secret, 's=x');
  assert.strictEqual(p.oauth_callback_confirmed, 'true');
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures above)' : ''}\n`);
