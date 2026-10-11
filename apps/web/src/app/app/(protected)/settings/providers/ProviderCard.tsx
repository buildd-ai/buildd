'use client';

import { useState, type ReactNode } from 'react';
import type {
  ListProvidersResponse,
  ProviderApiScope,
  ProviderCredentialSummary,
  ProviderShapeId,
} from '@buildd/shared';
import ConnectOpenRouterButton from '@/components/settings/ConnectOpenRouterButton';
import { formatCheckedAgo } from '@/lib/provider-keys-client';
import {
  ADMINS_ONLY,
  ADVANCED_ANCHOR,
  SHAPE_NOUN,
  cardView,
  detectPaste,
  maskedValue,
  rowState,
  type ProviderGroup,
} from './providers-view';

const INPUT = 'w-full h-11 md:h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-body';
const TONE = { error: 'text-status-error', success: 'text-status-success', muted: 'text-text-muted' } as const;

/**
 * One provider (or one group, like Claude: key and subscription) at one scope
 * tab, as a single row: name, a status word, the masked key, one action.
 * Everything else opens inline on tap. Values are write-only: a row shows its
 * last four characters.
 */
export default function ProviderRow({ group, scope, data, workspaceId, onChanged, open, onToggle, signIn = null }: {
  group: ProviderGroup;
  scope: ProviderApiScope;
  data: ListProvidersResponse;
  workspaceId: string | null;
  onChanged: () => Promise<void>;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The provider's subscription and runner sign-ins, drawn in the opened detail under the keys. */
  signIn?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const views = group.members.map((p) => ({ p, v: cardView(p, scope, data) }));
  const rows = views.flatMap(({ v }) => v.rows);
  const inherited = views.flatMap(({ v }) => v.inherited);
  const closedAll = views.every(({ v }) => v.closed);
  const closed = closedAll ? views[0].v.closed : null;
  const readOnly = views.find(({ v }) => v.readOnly)?.v.readOnly ?? null;
  const paste = views.filter(({ v }) => v.edit.kind === 'paste');
  const form = views.find(({ v }) => v.edit.kind === 'form');
  const state = rowState(rows, inherited, closed);
  const grouped = group.members.length > 1;

  const action = paste.length > 0
    ? (rows.length > 0 ? 'Replace' : grouped ? `Connect ${group.label}` : 'Add key')
    : null;

  function startEdit() {
    setEditing(true);
    onToggle(true);
  }

  return (
    <li data-testid={`provider-card-${group.id}`} data-scope={scope} data-set={rows.length > 0 ? 'true' : 'false'}>
      <div className="flex items-center gap-3 min-h-12 py-1.5">
        <button
          type="button"
          className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-left min-h-11"
          aria-expanded={open}
          data-testid="provider-row-toggle"
          onClick={() => onToggle(!open)}
        >
          <span className="text-body font-semibold text-text-primary">{group.label}</span>
          <span className={`text-meta ${TONE[state.tone]}`} data-testid="provider-card-state">{state.word}</span>
          {rows[0] && <span className={`text-meta text-text-muted ${maskedValue(rows[0]).startsWith('…') ? 'font-mono' : ''}`} data-testid="provider-masked">{maskedValue(rows[0])}</span>}
        </button>
        {action && !editing && (
          <button type="button" className="btn shrink-0" onClick={startEdit}>{action}</button>
        )}
        {!action && form && !form.v.closed && !form.v.readOnly && rows.length === 0 && (
          <a href={`#${ADVANCED_ANCHOR}`} className="btn shrink-0">Set up</a>
        )}
      </div>

      {open && (
        <div className="pb-3 space-y-2 text-body" data-testid="provider-detail">
          {rows.map((row) => <CredentialRow key={row.id} row={row} scope={scope} teamId={data.teamId} workspaceId={workspaceId} canRemove={!readOnly && !closed} onChanged={onChanged} />)}
          {inherited.length > 0 && (
            <p className="text-meta text-text-muted" data-testid="provider-inherits">
              Uses the team&apos;s {inherited.map((r) => `${SHAPE_NOUN[r.shape] ?? r.shape}${r.last4 ? ` …${r.last4}` : ''}`).join(', ')}
            </p>
          )}
          {closed && <p className="text-meta text-text-muted" data-testid="provider-closed">{closed}</p>}
          {/* "Admins can change this" is said once, at the top of the page
              (SettingsPage readOnly); a reason only this row has is said here. */}
          {readOnly && readOnly !== ADMINS_ONLY && <p className="text-meta text-text-muted" data-testid="provider-read-only">{readOnly}</p>}
          {editing && paste.length > 0 && (
            <PasteEditor
              group={group}
              shape={!grouped ? (paste[0].v.edit as { shape: ProviderShapeId }).shape : null}
              provider={!grouped ? paste[0].p.id : null}
              scope={scope}
              teamId={data.teamId}
              workspaceId={workspaceId}
              hasRow={rows.length > 0}
              onDone={async (saved) => { setEditing(false); if (saved) await onChanged(); }}
            />
          )}
          {editing && group.id === 'openrouter' && rows.length === 0 && scope !== 'workspace' && (
            <ConnectOpenRouterButton scope={scope === 'mine' ? 'user' : 'team'} teamId={data.teamId} returnTo={scope === 'mine' ? '/app/settings/keys' : '/app/settings/models'} />
          )}
          {form && (
            <p className="text-meta"><a href={`#${ADVANCED_ANCHOR}`} className="underline text-text-secondary hover:text-text-primary">Edit under Routing</a></p>
          )}
        </div>
      )}
      {/* Mounted while the row is shut: a device-code sign-in in progress survives a collapse. */}
      {signIn && <div hidden={!open} data-testid="provider-sign-in" className="pb-3 space-y-3">{signIn}</div>}
    </li>
  );
}

function CredentialRow({ row, scope, teamId, workspaceId, canRemove, onChanged }: {
  row: ProviderCredentialSummary;
  scope: ProviderApiScope;
  teamId: string;
  workspaceId: string | null;
  canRemove: boolean;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ teamId, provider: row.provider, scope, shape: row.shape });
      if (scope === 'workspace' && workspaceId) qs.set('workspaceId', workspaceId);
      const res = await fetch(`/api/providers?${qs}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorText(res, 'Could not remove.'));
      setConfirm(false);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="provider-row">
      <span className="text-text-primary">{SHAPE_NOUN[row.shape] ?? row.shape}{row.last4 && <span className="font-mono"> …{row.last4}</span>}</span>
      <span className="text-meta text-text-muted">{formatCheckedAgo(row.lastVerifiedAt, undefined)}</span>
      {canRemove && (confirm ? (
        <>
          <button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? 'Removing…' : 'Confirm remove'}</button>
          <button className="btn btn-quiet" onClick={() => setConfirm(false)} disabled={busy}>Keep</button>
        </>
      ) : (
        <button className="btn btn-quiet" onClick={() => setConfirm(true)}>Remove</button>
      ))}
      {row.lastVerificationError && <p className="w-full text-meta text-status-error break-words">{row.lastVerificationError}</p>}
      {err && <p role="alert" className="w-full text-meta text-status-error">{err}</p>}
    </div>
  );
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: string; reason?: string };
  return body.reason ?? body.error ?? fallback;
}

/**
 * One input. For a group (Claude, OpenAI) the pasted value's format decides
 * the provider and shape; for a single provider it is that provider's paste
 * shape.
 */
function PasteEditor({ group, provider, shape, scope, teamId, workspaceId, hasRow, onDone }: {
  group: ProviderGroup;
  provider: string | null;
  shape: ProviderShapeId | null;
  scope: ProviderApiScope;
  teamId: string;
  workspaceId: string | null;
  hasRow: boolean;
  onDone: (saved: boolean) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputId = `provider-${group.id}-${scope}`;
  const label = group.id === 'claude' ? 'Claude API key or setup token' : group.id === 'openai' ? 'OpenAI API key' : `${group.label} ${SHAPE_NOUN[shape ?? 'api_key'].toLowerCase().replace(/^api/, 'API')}`;

  async function save() {
    const target = provider && shape ? { provider, shape } : detectPaste(group.id, value);
    if ('error' in target) { setErr(target.error); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, provider: target.provider, shape: target.shape, scope, ...(scope === 'workspace' ? { workspaceId } : {}), value: value.trim() }),
      });
      if (!res.ok) throw new Error(await errorText(res, 'Could not save.'));
      setValue('');
      await onDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="field-label" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={INPUT}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={save} disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : hasRow ? 'Replace' : 'Save'}
        </button>
        <button className="btn btn-quiet" onClick={() => { setValue(''); void onDone(false); }} disabled={busy}>Cancel</button>
      </div>
      {err && <p role="alert" className="text-meta text-status-error">{err}</p>}
    </div>
  );
}
