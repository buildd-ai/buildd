'use client';

import { useState } from 'react';
import {
  checkKeyShape,
  formatCheckedAgo,
  keyHealthPill,
  type ChatProviderInfo,
  type ProviderKeyStatus,
} from '@/lib/provider-keys-client';

/**
 * One provider's key at one scope: the team key (admin screen) or your own key
 * (You page). The value is write-only: the card shows the server's masked form
 * and never reads the key back.
 */
export interface ProviderKeyCardProps {
  info: ChatProviderInfo;
  status: ProviderKeyStatus | null;
  mode: 'team' | 'personal';
  /** Team mode, admins only: members who set their own key for this provider. */
  ownKeyCount?: number | null;
  /** False renders the card read-only (a member looking at team keys). */
  canEdit: boolean;
  loading?: boolean;
  /** Resolves with the stored key (already checked by the provider), or rejects with the reason. */
  onSave: (value: string) => Promise<ProviderKeyStatus | null>;
  onRemove: () => Promise<void>;
  onTest: () => Promise<{ ok: boolean; error: string | null }>;
  /** Personal mode: one line saying which key chat uses for you. */
  inUse?: string;
  now?: Date;
}

export function ProviderKeyCard({
  info, status, mode, ownKeyCount = null, canEdit: canEditScope, loading = false, onSave, onRemove, onTest, inUse, now,
}: ProviderKeyCardProps) {
  // A key that serves chat from elsewhere (runner API key, decision key) is
  // shown but managed where it was set. Adding one here still works: it
  // becomes the inference key and takes precedence.
  const canEdit = canEditScope && (status?.managedHere ?? true);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'remove' | 'test'>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const configured = !!status;
  const pill = loading ? { tone: 'idle' as const, label: 'loading' } : keyHealthPill(status);
  const scopeLabel = mode === 'team' ? 'Team key' : 'Your key';
  const addLabel = mode === 'team' ? 'Add team key' : 'Use my own key';
  const shape = value ? checkKeyShape(info.id, value) : null;

  async function save() {
    const r = checkKeyShape(info.id, value);
    if (!r.ok) { setMsg({ tone: 'err', text: r.message ?? 'That key does not look right.' }); return; }
    setBusy('save');
    setMsg(null);
    try {
      const saved = await onSave(r.value);
      setValue('');
      setEditing(false);
      setMsg(saved?.health === 'ok' || !saved
        ? { tone: 'ok', text: `Saved. ${info.label} accepted the key.` }
        : { tone: 'warn', text: `Saved, but ${info.label} did not answer cleanly. Test it again in a minute.` });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save the key.' });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setMsg(null);
    try {
      await onRemove();
      setConfirmRemove(false);
      setMsg({ tone: 'ok', text: 'Key removed.' });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not remove the key.' });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setMsg(null);
    try {
      const r = await onTest();
      setMsg(r.ok
        ? { tone: 'ok', text: `${info.label} accepted the key.` }
        : { tone: 'err', text: r.error ?? `${info.label} rejected the key.` });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Test failed.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" data-testid={`provider-key-${info.id}`} data-configured={configured ? 'true' : 'false'}>
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border-default">
        <span className="w-2.5 h-2.5 shrink-0 bg-text-primary" aria-hidden />
        <b className="text-[13px] font-semibold text-text-primary">{info.label}</b>
        <span className="flex-1" />
        <span className={`status-pill status-pill-${pill.tone}`} data-testid="provider-key-health">{pill.label}</span>
      </div>

      <div className="px-3 pt-2 pb-3 space-y-1.5 text-xs">
        <Row label={scopeLabel}>
          {configured
            ? <span className="font-mono text-text-primary">{status?.masked ?? 'set'} <span className="text-text-muted">· {formatCheckedAgo(status?.lastVerifiedAt, now)}</span></span>
            : <span className="text-text-muted">none</span>}
        </Row>
        {mode === 'team' && ownKeyCount != null && (
          <Row label="Own keys">
            <span className="text-text-secondary">
              {ownKeyCount === 0 ? 'nobody' : `${ownKeyCount} ${ownKeyCount === 1 ? 'member' : 'members'}`}
            </span>
          </Row>
        )}
        {inUse && (
          <Row label="Chat uses">
            <span className="text-text-secondary" data-testid="provider-key-in-use">{inUse}</span>
          </Row>
        )}
        {status && status.health === 'failing' && status.error && (
          <p className="text-status-error break-words">Last check failed: {status.error}</p>
        )}
        {status?.sourceNote && (
          <p className="text-text-muted">{status.sourceNote}</p>
        )}

        {editing && canEdit && (
          <div className="pt-2 space-y-2">
            <label className="field-label" htmlFor={`key-${mode}-${info.id}`}>
              {configured ? `New ${info.label} key` : `${info.label} API key`}
            </label>
            <input
              id={`key-${mode}-${info.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={info.placeholder}
              className="w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs"
            />
            {shape?.message && (
              <p className={shape.ok ? 'text-status-warning' : 'text-status-error'}>{shape.message}</p>
            )}
            <p className="text-text-muted">
              Create one in the <a href={info.consoleUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-primary">{info.label} console</a>. buildd checks it with {info.label} before saving. Stored encrypted. Nobody can read it back.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={save} disabled={busy !== null || !value.trim() || shape?.ok === false}>
                {busy === 'save' ? 'Checking…' : configured ? 'Replace key' : 'Save key'}
              </button>
              <button className="btn btn-quiet" onClick={() => { setEditing(false); setValue(''); setMsg(null); }} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {!editing && canEdit && (
          <div className="pt-2 flex flex-wrap items-center gap-2">
            {configured ? (
              <>
                <button className="btn" onClick={test} disabled={busy !== null || loading}>
                  {busy === 'test' ? 'Testing…' : 'Test key'}
                </button>
                <button className="btn" onClick={() => { setEditing(true); setMsg(null); }} disabled={busy !== null || loading}>
                  Replace
                </button>
                {confirmRemove ? (
                  <>
                    <button className="btn btn-danger" onClick={remove} disabled={busy !== null}>
                      {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
                    </button>
                    <button className="btn btn-quiet" onClick={() => setConfirmRemove(false)} disabled={busy !== null}>Keep</button>
                  </>
                ) : (
                  <button className="btn btn-quiet" onClick={() => setConfirmRemove(true)} disabled={busy !== null || loading}>
                    Remove
                  </button>
                )}
              </>
            ) : (
              <button className="btn" onClick={() => { setEditing(true); setMsg(null); }} disabled={loading}>
                {addLabel}
              </button>
            )}
          </div>
        )}

        {confirmRemove && (
          <p className="text-text-secondary">
            {mode === 'team'
              ? 'Members without their own key lose chat on this provider.'
              : 'Chat falls back to the workspace or team key.'}
          </p>
        )}

        {msg && (
          <p
            role={msg.tone === 'err' ? 'alert' : 'status'}
            className={msg.tone === 'ok' ? 'text-status-success' : msg.tone === 'warn' ? 'text-status-warning' : 'text-status-error'}
          >
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-text-muted shrink-0">{label}</span>
      <span className="min-w-0 text-right truncate">{children}</span>
    </div>
  );
}

/** "Which key a chat turn uses", shared by both screens. */
export function KeyPrecedenceNote({ mode }: { mode: 'team' | 'personal' }) {
  return (
    <div className="border border-dashed border-border-strong px-3 py-2.5 text-xs text-text-secondary" data-testid="key-precedence">
      <b className="text-text-primary">Which key a chat turn uses</b>
      <ol className="list-decimal ml-5 mt-1.5 space-y-0.5">
        <li>Your own key{mode === 'personal' ? ' (set here)' : ''}</li>
        <li>The workspace key</li>
        <li>The team key{mode === 'team' ? ' (set here)' : ''}</li>
      </ol>
      <p className="text-text-muted mt-1.5">
        {mode === 'team'
          ? 'The team key covers everyone who has not added their own. A subscription seat can’t make these calls. With no key, chat stays off and says why.'
          : 'Your key wins for your turns only. Remove it and chat falls back to the team key. A subscription seat can’t make these calls.'}
      </p>
    </div>
  );
}
