/**
 * Encrypted access-token store for the E*TRADE proxy.
 *
 * The token pair is the only secret that lives on disk at runtime. It is encrypted with
 * AES-256-GCM under a key derived (scrypt) from ETRADE_TOKEN_KEY, so a leaked file alone
 * is useless. The file is gitignored; the key lives only in the VPS .env.
 *
 * Expiry model (verified against E*TRADE docs):
 *   - the access token DIES AT MIDNIGHT US/EASTERN, full stop. No automation can revive it;
 *     a human must redo the OAuth authorize step. We detect this by comparing the ET calendar
 *     day (en-CA, America/New_York) rather than doing UTC-offset math — same day-attribution
 *     discipline used everywhere else in NOVA.
 *   - separately, 2 hours with zero API calls marks the token INACTIVE. That one IS recoverable
 *     via GET /oauth/renew_access_token, which the proxy's keepalive fires every ~90 min.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INACTIVITY_LIMIT_MS = 2 * 60 * 60 * 1000; // E*TRADE: 2h of silence => inactive

/** ET calendar day key, e.g. "2026-09-17". */
function etDay(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}

class TokenStore {
  /**
   * @param {string} filePath  where the encrypted blob lives
   * @param {string} passphrase  ETRADE_TOKEN_KEY
   */
  constructor(filePath, passphrase) {
    if (!passphrase || passphrase.length < 16) {
      throw new Error('ETRADE_TOKEN_KEY missing or too short (need >= 16 chars)');
    }
    this.filePath = filePath;
    this.passphrase = passphrase;
    /** @type {null | {token:string, tokenSecret:string, etDay:string, acquiredAt:number, lastCallAt:number, accountIdKey:string|null}} */
    this.state = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const blob = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const key = deriveKey(this.passphrase, Buffer.from(blob.salt, 'hex'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'hex')), decipher.final()]);
      this.state = JSON.parse(plain.toString('utf8'));
    } catch (e) {
      // A bad key or a corrupt file must not silently start an unauthenticated server pretending
      // to be connected. Drop the state and force a fresh human login.
      console.error('[token-store] could not read token file, starting logged out:', e.message);
      this.state = null;
    }
  }

  _persist() {
    if (!this.state) {
      try {
        fs.existsSync(this.filePath) && fs.unlinkSync(this.filePath);
      } catch (_) {}
      return;
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(this.passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.state), 'utf8'), cipher.final()]);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({
        v: 1,
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        data: data.toString('hex'),
      }),
      { mode: 0o600 }
    );
  }

  set({ token, tokenSecret, accountIdKey = null }) {
    const now = Date.now();
    this.state = { token, tokenSecret, etDay: etDay(), acquiredAt: now, lastCallAt: now, accountIdKey };
    this._persist();
  }

  clear() {
    this.state = null;
    this._persist();
  }

  setAccountIdKey(accountIdKey) {
    if (!this.state) return;
    this.state.accountIdKey = accountIdKey;
    this._persist();
  }

  /** Call after every successful API request — resets the 2h inactivity clock. */
  touch() {
    if (!this.state) return;
    this.state.lastCallAt = Date.now();
    // Deliberately not persisted on every call (write amplification); persisted by the
    // keepalive tick and by set()/setAccountIdKey(). Losing a touch on crash is harmless —
    // the worst case is one extra renew_access_token call after restart.
  }

  persistNow() {
    this._persist();
  }

  /**
   * @returns {{state:'DISCONNECTED'|'EXPIRED'|'INACTIVE'|'CONNECTED', token?:string, tokenSecret?:string,
   *            accountIdKey?:string|null, etDay?:string, acquiredAt?:number, idleMs?:number}}
   */
  status() {
    if (!this.state) return { state: 'DISCONNECTED' };
    if (this.state.etDay !== etDay()) return { state: 'EXPIRED', etDay: this.state.etDay };

    const idleMs = Date.now() - this.state.lastCallAt;
    return {
      state: idleMs > INACTIVITY_LIMIT_MS ? 'INACTIVE' : 'CONNECTED',
      token: this.state.token,
      tokenSecret: this.state.tokenSecret,
      accountIdKey: this.state.accountIdKey,
      etDay: this.state.etDay,
      acquiredAt: this.state.acquiredAt,
      idleMs,
    };
  }

  /** Usable for signing (EXPIRED is not; INACTIVE is, because renew reactivates it). */
  credentials() {
    const s = this.status();
    if (s.state === 'DISCONNECTED' || s.state === 'EXPIRED') return null;
    return { token: s.token, tokenSecret: s.tokenSecret };
  }
}

module.exports = { TokenStore, etDay, INACTIVITY_LIMIT_MS };
