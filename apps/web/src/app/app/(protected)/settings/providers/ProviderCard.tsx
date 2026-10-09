'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  ExplainProviderResponse,
  ListProvidersResponse,
  ProviderApiScope,
  ProviderCredentialSummary,
  ProviderListing,
  ProviderShapeId,
} from '@buildd/shared';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import ConnectOpenRouterButton from '@/components/settings/ConnectOpenRouterButton';
import { formatCheckedAgo } from '@/lib/provider-keys-client';
import {
  ADVANCED_ANCHOR,
  SEAT_CONNECT_HREF,
  SHAPE_NOUN,
  SURFACE_LABEL,
  cardView,
  explainAs,
  explainLine,
  explainUrl,
  servesLine,
  surfaceList,
} from './providers-view';

const INPUT = 'w-full h-11 md:h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-body';

/**
 * One provider at one scope tab: what it serves (and the registry's reason
 * for what it can't), what is set here, and set / replace / remove when the
 * caller may. Values are write-only: a row shows its last four characters.
 */
export default function ProviderCard({ provider: p, scope, data, workspaceId, onChanged, labelOf, now }: {
  provider: ProviderListing;
  scope: ProviderApiScope;
  data: ListProvidersResponse;
  workspaceId: string | null;
  onChanged: () => Promise<void>;
  labelOf: (provider: string) => string;
  now?: Date;
}) {
  const view = cardView(p, scope, data);
  const lines = servesLine(p);
  const head = headState(view.rows, view.inherited, view.closed);

  return (
    <div className="card" data-testid={`provider-card-${p.id}`} data-scope={scope} data-set={view.rows.length > 0 ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0 px-3 py-2.5 border-b border-border-default">
        <b className="min-w-0 break-words text-title text-text-primary">{p.label}</b>
        <span className="ml-auto shrink-0"><Chip tone={head.tone} data-testid="provider-card-state">{head.label}</Chip></span>
      </div>

      <div className="px-3 pt-2 pb-3 space-y-2 text-body">
        <p className="text-text-secondary" data-testid="provider-serves">
          <span className="text-text-muted">Serves </span>{lines.serves.length ? surfaceList(lines.serves) : 'nothing'}
        </p>
        {lines.not.length > 0 && (
          <ul className="space-y-0.5 text-meta text-text-muted" data-testid="provider-not">
            {lines.not.map((n) => (
              <li key={n.surface}><span className="text-text-secondary">Not {SURFACE_LABEL[n.surface].toLowerCase()}:</span> {n.reason}</li>
            ))}
          </ul>
        )}

        {view.rows.map((row) => <CredentialRow key={row.id} row={row} now={now} />)}
        {view.inherited.length > 0 && (
          <p className="text-meta text-text-muted" data-testid="provider-inherits">
            Inherits team: {view.inherited.map((r) => `${SHAPE_NOUN[r.shape] ?? r.shape}${r.last4 ? ` …${r.last4}` : ''}`).join(', ')}
          </p>
        )}

        {view.closed && <p className="text-meta text-text-muted" data-testid="provider-closed">{view.closed}</p>}
        {view.readOnly && <p className="text-meta text-text-muted" data-testid="provider-read-only">{view.readOnly}</p>}

        {view.edit.kind === 'paste' && (
          <PasteControls
            provider={p}
            shape={view.edit.shape}
            scope={scope}
            teamId={data.teamId}
            workspaceId={workspaceId}
            hasRow={view.rows.some((r) => r.shape === (view.edit as { shape: ProviderShapeId }).shape)}
            onChanged={onChanged}
            extra={p.id === 'openrouter' && view.rows.length === 0 && scope !== 'workspace'
              ? <ConnectOpenRouterButton scope={scope === 'mine' ? 'user' : 'team'} teamId={data.teamId} returnTo="/app/settings/providers" />
              : null}
          />
        )}
        {view.edit.kind === 'form' && (
          <p><a href={`#${ADVANCED_ANCHOR}`} className="underline text-accent-text hover:no-underline">Set up under Advanced</a></p>
        )}
        {view.connectInBrowser && !view.closed && (
          <p className="text-meta">
            <Link href={SEAT_CONNECT_HREF} className="underline text-text-secondary hover:text-text-primary" data-testid="provider-connect-seat">
              Connect a subscription in the browser
            </Link>
          </p>
        )}

        {lines.serves.length > 0 && (
          <Disclosure summary="What runs?">
            <ExplainPanel
              teamId={data.teamId}
              provider={p.id}
              surfaces={lines.serves}
              workspaceId={scope === 'team' ? null : workspaceId}
              as={explainAs(scope, data.caller.canSetMine)}
              labelOf={labelOf}
            />
          </Disclosure>
        )}
      </div>
    </div>
  );
}

function headState(rows: ProviderCredentialSummary[], inherited: ProviderCredentialSummary[], closed: string | null): { tone: ChipTone; label: string } {
  if (rows.some((r) => r.health === 'revoked')) return { tone: 'error', label: 'revoked' };
  if (rows.some((r) => r.health === 'healthy')) return { tone: 'success', label: 'healthy' };
  if (rows.length > 0) return { tone: 'muted', label: 'set' };
  if (inherited.length > 0) return { tone: 'muted', label: 'inherits team' };
  if (closed) return { tone: 'muted', label: 'not available' };
  return { tone: 'muted', label: 'not set' };
}

function CredentialRow({ row, now }: { row: ProviderCredentialSummary; now?: Date }) {
  return (
    <div className="inset-panel space-y-0.5" data-testid="provider-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-text-primary">
          {SHAPE_NOUN[row.shape] ?? row.shape}
          {row.last4 && <span className="font-mono"> …{row.last4}</span>}
        </span>
        <span className="text-meta text-text-muted">{formatCheckedAgo(row.lastVerifiedAt, now)}</span>
      </div>
      <p className="text-meta text-text-muted" data-testid="provider-row-serves">
        {row.servesToday.length ? `Used for ${surfaceList(row.servesToday).toLowerCase()}` : 'Not used by anything yet'}
      </p>
      {row.lastVerificationError && <p className="text-meta text-status-error break-words">{row.lastVerificationError}</p>}
    </div>
  );
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: string; reason?: string };
  return body.reason ?? body.error ?? fallback;
}

function PasteControls({ provider, shape, scope, teamId, workspaceId, hasRow, onChanged, extra }: {
  provider: ProviderListing;
  shape: ProviderShapeId;
  scope: ProviderApiScope;
  teamId: string;
  workspaceId: string | null;
  hasRow: boolean;
  onChanged: () => Promise<void>;
  extra: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'remove'>(null);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const noun = SHAPE_NOUN[shape];
  const inputId = `provider-${provider.id}-${scope}`;

  async function save() {
    setBusy('save');
    setMsg(null);
    try {
      const res = await fetch('/api/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, provider: provider.id, shape, scope, ...(scope === 'workspace' ? { workspaceId } : {}), value: value.trim() }),
      });
      if (!res.ok) throw new Error(await errorText(res, 'Could not save.'));
      setValue('');
      setEditing(false);
      setMsg({ ok: true, text: 'Saved.' });
      await onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setMsg(null);
    try {
      const qs = new URLSearchParams({ teamId, provider: provider.id, scope, shape });
      if (scope === 'workspace' && workspaceId) qs.set('workspaceId', workspaceId);
      const res = await fetch(`/api/providers?${qs}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorText(res, 'Could not remove.'));
      setConfirm(false);
      setMsg({ ok: true, text: 'Removed.' });
      await onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not remove.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pt-1 space-y-2">
      {editing ? (
        <>
          <label className="field-label" htmlFor={inputId}>{hasRow ? `New ${noun.toLowerCase()}` : noun}</label>
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
            <button className="btn btn-primary" onClick={save} disabled={busy !== null || !value.trim()}>
              {busy === 'save' ? 'Checking…' : hasRow ? 'Replace' : 'Save'}
            </button>
            <button className="btn btn-quiet" onClick={() => { setEditing(false); setValue(''); setMsg(null); }} disabled={busy !== null}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" onClick={() => { setEditing(true); setMsg(null); }} disabled={busy !== null}>
            {hasRow ? 'Replace' : `Add ${noun.toLowerCase().replace(/^api/, 'API')}`}
          </button>
          {hasRow && (confirm ? (
            <>
              <button className="btn btn-danger" onClick={remove} disabled={busy !== null}>{busy === 'remove' ? 'Removing…' : 'Confirm remove'}</button>
              <button className="btn btn-quiet" onClick={() => setConfirm(false)} disabled={busy !== null}>Keep</button>
            </>
          ) : (
            <button className="btn btn-quiet" onClick={() => setConfirm(true)} disabled={busy !== null}>Remove</button>
          ))}
          {!hasRow && extra}
        </div>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-meta ${msg.ok ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</p>}
    </div>
  );
}

/** "What runs?": the resolver's answer per surface for this provider, and its trail. No values. */
function ExplainPanel({ teamId, provider, surfaces, workspaceId, as, labelOf }: {
  teamId: string;
  provider: string;
  surfaces: ExplainProviderResponse['surface'][];
  workspaceId: string | null;
  as: 'self' | 'team';
  labelOf: (provider: string) => string;
}) {
  const [answers, setAnswers] = useState<Array<ExplainProviderResponse | { surface: ExplainProviderResponse['surface']; error: string }> | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all(surfaces.map(async (surface) => {
      try {
        const res = await fetch(explainUrl({ teamId, provider, surface, workspaceId, as }));
        if (!res.ok) return { surface, error: await errorText(res, 'Could not explain.') };
        return (await res.json()) as ExplainProviderResponse;
      } catch {
        return { surface, error: 'Could not explain.' };
      }
    })).then((a) => { if (live) setAnswers(a); });
    return () => { live = false; };
  }, [teamId, provider, surfaces.join(','), workspaceId, as]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!answers) return <p className="text-meta text-text-muted py-1">Loading…</p>;
  return (
    <div className="space-y-2 pb-1" data-testid="provider-explain">
      <p className="text-meta text-text-muted">{as === 'self' ? 'For work you start:' : 'For team work:'}</p>
      {answers.map((a) => (
        <div key={a.surface}>
          <p className="text-text-primary" data-testid="provider-explain-line">
            {'error' in a ? `${SURFACE_LABEL[a.surface]}: ${a.error}` : explainLine(a, labelOf)}
          </p>
          {!('error' in a) && a.why.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-meta text-text-muted">
              {a.why.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
