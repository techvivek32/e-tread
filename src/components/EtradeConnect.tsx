/**
 * E*TRADE connection UI — the one manual step of the trading day.
 *
 * IBKR needed a username + password + phone 2FA on the gateway's own login page. E*TRADE uses
 * OAuth 1.0a instead: the trader approves NOVA on E*TRADE's site and brings back a
 * 5-character verification code. NOVA never sees the E*TRADE password, which is why this
 * screen asks for a code and not for credentials.
 *
 * Also renders the two things a trader must never miss:
 *   - the token dies at MIDNIGHT ET; this says so, in plain words, before it bites
 *   - the synthetic bracket engine's health — if it is down, targets are not being watched,
 *     and that has to be loud (gotcha #21: a missed warning cost a whole exit once)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  completeAuth,
  getAuthStatus,
  listAccounts,
  logout,
  selectAccount,
  startAuth,
  type AuthStatus,
} from '../lib/api/etrade';

type Account = { accountId: string; accountIdKey: string; accountName: string; accountStatus: string };

const PILL: Record<AuthStatus['state'], { label: string; cls: string }> = {
  CONNECTED: { label: 'E*TRADE connected', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  INACTIVE: { label: 'Idle — reconnecting', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  EXPIRED: { label: 'Session expired', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  DISCONNECTED: { label: 'Not connected', cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
};

export function EtradeSessionPill({ status }: { status: AuthStatus | null }) {
  const s = status?.state ?? 'DISCONNECTED';
  const p = PILL[s];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${p.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {p.label}
      {status?.etradeEnv === 'sandbox' && (
        <span className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
          sandbox
        </span>
      )}
    </span>
  );
}

/**
 * Loud, persistent banner. Never auto-dismisses: an unwatched target is a live risk, and a
 * toast the trader scrolled past is the same as no warning at all.
 */
export function BracketHealthBanner({ status }: { status: AuthStatus | null }) {
  const oco = status?.oco;
  if (!oco || oco.healthy || oco.active === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
      <div className="font-semibold text-red-300">Bracket monitor is not running</div>
      <p className="mt-1">
        {oco.active} bracket{oco.active === 1 ? '' : 's'} {oco.active === 1 ? 'is' : 'are'} registered, but the
        target watcher is {oco.staleMs > 0 ? `${Math.round(oco.staleMs / 1000)}s stale` : 'not reporting'}.
        <strong className="mx-1">Your stops are still live at E*TRADE</strong>
        (they are real broker orders), but profit targets are <strong>not</strong> being watched right now.
        Manage exits manually until this clears.
      </p>
      {oco.lastError && <p className="mt-2 font-mono text-xs opacity-80">{oco.lastError}</p>}
    </div>
  );
}

export default function EtradeConnect() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [verifier, setVerifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getAuthStatus();
      setStatus(s);
      if (s.authenticated && accounts.length === 0) {
        setAccounts(await listAccounts().catch(() => []));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accounts.length]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000); // matches the IBKR build's auth-status cadence
    return () => clearInterval(t);
  }, [refresh]);

  async function onStart() {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl: url } = await startAuth();
      setAuthorizeUrl(url);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onComplete(e: React.FormEvent) {
    e.preventDefault();
    if (!verifier.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await completeAuth(verifier);
      setAccounts(out.accounts as Account[]);
      setVerifier('');
      setAuthorizeUrl(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await logout();
      setAccounts([]);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.authenticated || status?.state === 'INACTIVE';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <BracketHealthBanner status={status} />

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Broker — E*TRADE</h2>
            <p className="mt-1 text-sm text-zinc-400">
              NOVA connects through E*TRADE's own authorisation page. Your E*TRADE password is never
              entered here and never stored.
            </p>
          </div>
          <EtradeSessionPill status={status} />
        </div>

        {status?.state === 'EXPIRED' && (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            E*TRADE access tokens expire at <strong>midnight US Eastern</strong>, every day. Nothing on the
            server can renew a token past that point — reconnect below to trade today.
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {!connected && (
          <div className="mt-5 space-y-4">
            <ol className="space-y-3 text-sm text-zinc-300">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs">
                  1
                </span>
                <div className="flex-1">
                  <button
                    type="button"
                    onClick={onStart}
                    disabled={busy}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {busy ? 'Opening…' : 'Authorise on E*TRADE'}
                  </button>
                  {authorizeUrl && (
                    <p className="mt-2 text-xs text-zinc-500">
                      Didn't open?{' '}
                      <a className="underline" href={authorizeUrl} target="_blank" rel="noopener noreferrer">
                        Open the E*TRADE authorisation page
                      </a>
                    </p>
                  )}
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs">
                  2
                </span>
                <span>Log in at E*TRADE and accept. It shows a 5-character code.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs">
                  3
                </span>
                <form onSubmit={onComplete} className="flex flex-1 flex-wrap gap-2">
                  <input
                    value={verifier}
                    onChange={(e) => setVerifier(e.target.value.toUpperCase())}
                    placeholder="Verification code"
                    maxLength={12}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-44 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm uppercase tracking-widest text-zinc-100 outline-none focus:border-emerald-500"
                  />
                  <button
                    type="submit"
                    disabled={busy || !verifier.trim() || !authorizeUrl}
                    className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
                  >
                    Connect
                  </button>
                </form>
              </li>
            </ol>
          </div>
        )}

        {connected && (
          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Field label="Environment" value={status?.etradeEnv ?? '—'} />
              <Field label="Trading day (ET)" value={status?.etDay ?? '—'} />
              <Field label="Account" value={status?.accountIdKey ? `…${status.accountIdKey.slice(-6)}` : '—'} />
            </div>

            {accounts.length > 1 && (
              <label className="block text-sm">
                <span className="text-zinc-400">Account</span>
                <select
                  value={status?.accountIdKey ?? ''}
                  onChange={(e) => {
                    selectAccount(e.target.value);
                    refresh();
                  }}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                >
                  {accounts.map((a) => (
                    <option key={a.accountIdKey} value={a.accountIdKey}>
                      {a.accountName} · {a.accountId} · {a.accountStatus}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <p className="text-xs text-zinc-500">
              This session ends automatically at midnight US Eastern. Reconnect each trading morning.
            </p>

            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 font-medium text-zinc-200">{value}</div>
    </div>
  );
}
