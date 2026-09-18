/**
 * Request throttle for the E*TRADE API.
 *
 * E*TRADE does NOT publish rate limits, and there is no WebSocket — every quote is a REST call.
 * So we self-limit rather than discover the ceiling by getting blocked mid-session:
 *   - a token bucket at RPS requests/second
 *   - a hard concurrency cap
 *   - a global cooldown whenever the API answers 429 (exponential, capped)
 *
 * Tune RPS from the real numbers measured on day 1 (see 09-ETRADE-PORT-PLAN.md §3 VERIFY).
 */

'use strict';

class Throttle {
  constructor({ rps = 4, concurrency = 4, maxBackoffMs = 60000 } = {}) {
    this.rps = rps;
    this.concurrency = concurrency;
    this.maxBackoffMs = maxBackoffMs;

    this.queue = [];
    this.inFlight = 0;
    this.tokens = rps;
    this.pausedUntil = 0;
    this.backoffMs = 0;
    this.refill = null;
  }

  /**
   * The refill timer runs ONLY while there is work, and is a normal referenced timer.
   *
   * It used to be a permanent unref'd interval, which silently broke every non-server caller:
   * once the bucket emptied, the queued request was waiting on a timer that did not hold the
   * event loop open, so Node decided it had nothing left to do and exited cleanly — mid-run,
   * exit code 0, no error. A long-running server never noticed (its listening socket keeps the
   * loop alive) but a CLI check lost its last few calls. Starting and stopping it around real
   * work keeps a script alive exactly as long as it has requests outstanding, and still lets
   * the process exit the moment it is idle.
   */
  _ensureTimer() {
    if (this.refill) return;
    this.refill = setInterval(() => {
      this.tokens = this.rps;
      this._drain();
      if (!this.queue.length && !this.inFlight) this._stopTimer();
    }, 1000);
  }

  _stopTimer() {
    if (!this.refill) return;
    clearInterval(this.refill);
    this.refill = null;
  }

  /** Wrap an async fn so it only runs when a slot and a token are free. */
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._ensureTimer();
      this._drain();
    });
  }

  /** Call when the API returns 429 — everything backs off together. */
  noteRateLimited() {
    this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 2000, this.maxBackoffMs);
    this.pausedUntil = Date.now() + this.backoffMs;
    console.warn(`[throttle] 429 from E*TRADE — pausing all calls for ${this.backoffMs}ms`);
  }

  /** Call after a clean response — decays the backoff. */
  noteOk() {
    if (this.backoffMs) this.backoffMs = Math.floor(this.backoffMs / 2);
  }

  _drain() {
    const now = Date.now();
    if (now < this.pausedUntil) {
      setTimeout(() => this._drain(), this.pausedUntil - now).unref?.();
      return;
    }
    while (this.queue.length && this.inFlight < this.concurrency && this.tokens > 0) {
      const job = this.queue.shift();
      this.tokens -= 1;
      this.inFlight += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.inFlight -= 1;
          this._drain();
          if (!this.queue.length && !this.inFlight && this.tokens > 0) this._stopTimer();
        });
    }
  }

  /** Release the timer so a finished process can exit. */
  stop() {
    this._stopTimer();
  }

  stats() {
    return { queued: this.queue.length, inFlight: this.inFlight, backoffMs: this.backoffMs };
  }
}

module.exports = { Throttle };
