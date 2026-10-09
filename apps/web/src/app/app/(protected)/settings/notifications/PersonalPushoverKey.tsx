'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatCheckedAgo, type ProviderKeyStatus } from '@/lib/provider-keys-client';
import { checkPushoverKeyShape, pushoverKeyStatus, type PersonalPushoverWire } from '@/lib/pushover-key-shape';
import ChannelRow from './ChannelRow';

const CONSOLE_URL = 'https://pushover.net';

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`;
}

/**
 * Settings › Notifications: your own Pushover key, as the "Pushover · yours"
 * row of the Channels list. Alerts for things you watch go here when you are
 * away (api/me/pushover). Set, test, replace, remove; the key never comes back
 * beyond last4.
 */
export default function PersonalPushoverKey({ teamId }: { teamId: string }) {
  const [status, setStatus] = useState<ProviderKeyStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'remove' | 'test'>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const qs = `teamId=${encodeURIComponent(teamId)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/me/pushover?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const body = await res.json() as { key?: PersonalPushoverWire | null };
      setStatus(pushoverKeyStatus(body.key));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your Pushover key');
    } finally {
      setLoaded(true);
    }
  }, [qs]);

  useEffect(() => { void load(); }, [load]);

  const configured = !!status;
  const shape = value ? checkPushoverKeyShape(value) : null;

  async function run(kind: 'save' | 'remove' | 'test', fn: () => Promise<void>) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  }

  const save = () => run('save', async () => {
    const r = checkPushoverKeyShape(value);
    if (!r.ok) throw new Error(r.message ?? 'That key does not look right.');
    const res = await fetch('/api/me/pushover', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, value: r.value }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const body = await res.json() as { key?: PersonalPushoverWire };
    const next = pushoverKeyStatus(body.key);
    setStatus(next);
    setValue('');
    setEditing(false);
    setMsg(next?.health === 'ok' || !next
      ? { tone: 'ok', text: 'Saved. Pushover accepted the key.' }
      : { tone: 'warn', text: 'Saved, but Pushover did not answer cleanly. Test it again in a minute.' });
  });

  const remove = () => run('remove', async () => {
    const res = await fetch(`/api/me/pushover?${qs}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorText(res));
    setConfirmRemove(false);
    await load();
    setMsg({ tone: 'ok', text: 'Key removed.' });
  });

  const test = () => run('test', async () => {
    const res = await fetch('/api/me/pushover/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const r = await res.json() as { ok: boolean; error: string | null };
    await load();
    setMsg(r.ok ? { tone: 'ok', text: 'Pushover accepted the key.' } : { tone: 'err', text: r.error ?? 'Pushover rejected the key.' });
  });

  const sub = (
    <>
      {configured
        ? <><span className="font-mono">{status?.masked}</span>{status?.lastVerifiedAt && <span className="text-text-muted"> · {formatCheckedAgo(status.lastVerifiedAt)}</span>}</>
        : 'Alerts for things you watch, sent to your phone when you are away.'}
      {status?.health === 'failing' && status.error && (
        <span className="block text-status-error break-words">Last check failed: {status.error}</span>
      )}
      {loadError && <span className="block text-status-error" role="alert">{loadError}</span>}
    </>
  );

  const actions = editing ? null : configured ? (
    confirmRemove ? (
      <>
        <button className="btn btn-sm btn-danger" onClick={remove} disabled={busy !== null}>
          {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
        </button>
        <button className="btn btn-sm btn-quiet" onClick={() => setConfirmRemove(false)} disabled={busy !== null}>Keep</button>
      </>
    ) : (
      <>
        <button className="btn btn-sm" onClick={test} disabled={busy !== null || !loaded}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        <button className="btn btn-sm" onClick={() => { setEditing(true); setMsg(null); }} disabled={busy !== null || !loaded}>Replace</button>
        <button className="btn btn-sm btn-quiet" onClick={() => setConfirmRemove(true)} disabled={busy !== null || !loaded}>Remove</button>
      </>
    )
  ) : (
    <button className="btn btn-sm" onClick={() => { setEditing(true); setMsg(null); }} disabled={!loaded}>Add your key</button>
  );

  const showBody = editing || confirmRemove || !!msg;

  return (
    <ChannelRow
      title="Pushover · yours"
      connected={configured}
      sub={sub}
      actions={actions}
      testId="personal-pushover"
      pillTestId="provider-key-health"
    >
      {showBody ? (
        <>
          {editing && (
            <>
              <label className="field-label" htmlFor="personal-pushover-key">{configured ? 'New user key' : 'Your user key'}</label>
              <input
                id="personal-pushover-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="u… (30 letters and digits)"
                className="w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs"
              />
              {shape?.message && (
                <p className={`text-xs ${shape.ok ? 'text-status-warning' : 'text-status-error'}`}>{shape.message}</p>
              )}
              <p className="text-xs text-text-muted">
                Your user key is on your <a href={CONSOLE_URL} target="_blank" rel="noreferrer" className="underline hover:text-text-primary">Pushover dashboard</a>. Tested on save. Encrypted, write-only.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-primary" onClick={save} disabled={busy !== null || !value.trim() || shape?.ok === false}>
                  {busy === 'save' ? 'Checking…' : configured ? 'Replace key' : 'Save key'}
                </button>
                <button className="btn btn-quiet" onClick={() => { setEditing(false); setValue(''); setMsg(null); }} disabled={busy !== null}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {confirmRemove && <p className="text-xs text-text-secondary">Phone alerts stop. They still show in chat.</p>}
          {msg && (
            <p
              role={msg.tone === 'err' ? 'alert' : 'status'}
              className={`text-xs ${msg.tone === 'ok' ? 'text-status-success' : msg.tone === 'warn' ? 'text-status-warning' : 'text-status-error'}`}
            >
              {msg.text}
            </p>
          )}
        </>
      ) : null}
    </ChannelRow>
  );
}
