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
  SHAPE_NOUN,
  cardView,
  maskedValue,
  rowState,
  type ProviderRowItem,
} from './providers-view';

const INPUT = 'w-full h-11 md:h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-body';
const TONE = { error: 'text-status-error', success: 'text-status-success', muted: 'text-text-muted' } as const;

/**
 * One provider at one scope, as a single row: its name and one action, with a
 * status word and the masked key once something is set. Everything else opens
 * inline on tap. Values are write-only: a row shows its last four characters.
 */
export default function ProviderRow({ item, scope, data, workspaceId, onChanged, open, onToggle, form: formSlot = null }: {
  item: ProviderRowItem;
  scope: ProviderApiScope;
  data: ListProvidersResponse;
  workspaceId: string | null;
  onChanged: () => Promise<void>;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** A provider set up with a form (gateway, custom endpoint): the form, drawn in the opened detail. */
  form?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const { rows, inherited, closed, readOnly, edit } = cardView(item.provider, scope, data);
  const paste = edit.kind === 'paste' ? edit : null;
  const form = edit.kind === 'form';
  const state = rowState(rows, inherited, data.teamName);
  // Set up only through a form this page does not draw (the gateway on a
  // workspace page), with nothing set or inherited: no row, not a dead "Not set".
  if (form && !formSlot && !closed && rows.length === 0 && inherited.length === 0) return null;

  const action = paste ? (rows.length > 0 ? 'Replace' : 'Add key') : null;

  function startEdit() {
    setEditing(true);
    onToggle(true);
  }

  return (
    <li data-testid={`provider-card-${item.id}`} data-scope={scope} data-set={rows.length > 0 ? 'true' : 'false'}>
      <div className="flex items-center gap-3 min-h-12 py-1.5">
        <button
          type="button"
          className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-left min-h-11"
          aria-expanded={open}
          data-testid="provider-row-toggle"
          onClick={() => onToggle(!open)}
        >
          <span className="text-body font-semibold text-text-primary">{item.label}</span>
          {state.word && <span className={`text-meta ${TONE[state.tone]}`} data-testid="provider-card-state">{state.word}</span>}
          {rows[0] && <span className={`text-meta text-text-muted ${maskedValue(rows[0]).startsWith('…') ? 'font-mono' : ''}`} data-testid="provider-masked">{maskedValue(rows[0])}</span>}
        </button>
        {/* 44px to tap below md, the usual 32px .btn from md. */}
        {action && !editing && (
          <button type="button" className="btn shrink-0 min-h-11 md:min-h-0" onClick={startEdit}>{action}</button>
        )}
        {!action && form && formSlot && rows.length === 0 && !open && (
          <button type="button" className="btn shrink-0 min-h-11 md:min-h-0" onClick={() => onToggle(true)}>Set up</button>
        )}
      </div>

      {open && (
        <div className="pb-3 space-y-2 text-body" data-testid="provider-detail">
          {/* A form (gateway, endpoint) shows its own masked key and Remove. */}
          {!(form && formSlot) && rows.map((row) => <CredentialRow key={row.id} row={row} scope={scope} teamId={data.teamId} workspaceId={workspaceId} canRemove={!readOnly && !closed} onChanged={onChanged} />)}
          {inherited.length > 0 && (
            <p className="text-meta text-text-muted" data-testid="provider-inherits">
              Uses the team&apos;s {inherited.map((r) => `${SHAPE_NOUN[r.shape] ?? r.shape}${r.last4 ? ` …${r.last4}` : ''}`).join(', ')}
            </p>
          )}
          {closed && <p className="text-meta text-text-muted" data-testid="provider-closed">{closed}</p>}
          {/* "Admins can change this" is said once, at the top of the page
              (SettingsPage readOnly); a reason only this row has is said here. */}
          {readOnly && readOnly !== ADMINS_ONLY && <p className="text-meta text-text-muted" data-testid="provider-read-only">{readOnly}</p>}
          {editing && paste && (
            <PasteEditor
              item={item}
              shape={paste.shape}
              scope={scope}
              teamId={data.teamId}
              workspaceId={workspaceId}
              hasRow={rows.length > 0}
              onDone={async (saved) => { setEditing(false); if (saved) await onChanged(); }}
            />
          )}
          {editing && item.id === 'openrouter' && rows.length === 0 && scope !== 'workspace' && (
            <ConnectOpenRouterButton scope={scope === 'mine' ? 'user' : 'team'} teamId={data.teamId} returnTo={scope === 'mine' ? '/app/settings/keys' : '/app/settings/models'} />
          )}
          {form && formSlot}
        </div>
      )}
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

/** One input: the provider's key. */
function PasteEditor({ item, shape, scope, teamId, workspaceId, hasRow, onDone }: {
  item: ProviderRowItem;
  shape: ProviderShapeId;
  scope: ProviderApiScope;
  teamId: string;
  workspaceId: string | null;
  hasRow: boolean;
  onDone: (saved: boolean) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputId = `provider-${item.id}-${scope}`;
  const label = `${item.label} ${SHAPE_NOUN[shape].toLowerCase().replace(/^api/, 'API')}`;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, provider: item.provider.id, shape, scope, ...(scope === 'workspace' ? { workspaceId } : {}), value: value.trim() }),
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
