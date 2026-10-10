'use client';

/**
 * Settings → Connected apps: the MCP apps the signed-in person connected to
 * buildd (docs/specs/auth-oauth-boundaries.md, "Managing connections").
 *
 * Each connection is one hairline row: the app's name, whether it acts as the
 * person or as their agent, and one line of meta. Opening a row shows what it
 * reaches, grouped by team, and every change it allows: add or remove
 * workspaces (the consent page's picker), read only or read and write, make
 * it an agent, revoke. A connection that is an agent cannot be made to act as
 * the person here; that takes a fresh consent.
 *
 * Every change goes to /api/mcp-grants and applies on the app's next request.
 */
import { useState } from 'react';
import ConnectionRow, { StatusChip } from '../_components/ConnectionRow';
import Notice from '@/components/ui/Notice';
import Segmented from '@/components/ui/Segmented';
import Section from '@/components/ui/Section';
import type { ConsentTeam } from '@/lib/oauth/account-consent';
import type { ConnectionAccess, ConnectionSummary, LegacyConnectionSummary } from '@/lib/mcp-grant-patch';
import WorkspacePicker from './WorkspacePicker';
import { ACCESS_LABEL, KIND_LABEL, byTeam, connectionMeta, lastActive, selectionChange } from './connections-view';

export interface ConnectionsData {
  connections: ConnectionSummary[];
  legacy: LegacyConnectionSummary[];
  teams: ConsentTeam[];
}

type PatchBody = { addWorkspaceIds?: string[]; removeWorkspaceIds?: string[]; access?: ConnectionAccess; actsAs?: 'agent' };

/** The two calls the section makes. The dev fixture swaps in a local one. */
export interface ConnectionsApi {
  patch(id: string, body: PatchBody): Promise<{ ok: true; connection: ConnectionSummary } | { ok: false; error: string }>;
  revoke(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.error === 'string' && body.error ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export const fetchConnectionsApi: ConnectionsApi = {
  async patch(id, body) {
    const res = await fetch(`/api/mcp-grants/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res, 'Could not save the change. Try again.') };
    return { ok: true, connection: (await res.json()).connection };
  },
  async revoke(id) {
    const res = await fetch(`/api/mcp-grants/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: await errorOf(res, 'Could not revoke it. Try again.') };
    return { ok: true };
  },
};

const ROWS = 'divide-y divide-border-default border-y border-border-default';

export default function ConnectionsSection({
  initial,
  api = fetchConnectionsApi,
  initiallyOpen = null,
  now,
}: {
  initial: ConnectionsData;
  api?: ConnectionsApi;
  /** Fixture only: a connection to show open. */
  initiallyOpen?: string | null;
  /** Fixture only: a fixed clock for the "active" words. */
  now?: Date;
}) {
  const [connections, setConnections] = useState(initial.connections);
  const [open, setOpen] = useState<string | null>(initiallyOpen);
  const [revoked, setRevoked] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      {initial.legacy.length > 0 && <LegacyNotice legacy={initial.legacy} now={now} />}

      <Section title="Your apps" count={connections.length}>
        {connections.length === 0 ? (
          <p className="text-body text-text-muted" data-testid="connections-empty">
            {revoked ? `${revoked} is disconnected. ` : ''}No apps are connected. Connect one with <code className="font-mono">buildd install --oauth</code>, or add buildd as an MCP server in the app.
          </p>
        ) : (
          <>
            {revoked && <p className="mb-3 text-body text-text-secondary" role="status">{revoked} is disconnected.</p>}
            <div className={ROWS} data-testid="connections-list">
              {connections.map((c) => (
                <ConnectionItem
                  key={c.id}
                  connection={c}
                  teams={initial.teams}
                  api={api}
                  now={now}
                  open={open === c.id}
                  onToggle={() => setOpen(open === c.id ? null : c.id)}
                  onChange={(next) => setConnections((list) => list.map((x) => (x.id === next.id ? next : x)))}
                  onRevoked={() => {
                    setConnections((list) => list.filter((x) => x.id !== c.id));
                    setRevoked(c.clientName);
                    setOpen(null);
                  }}
                />
              ))}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

function LegacyNotice({ legacy, now }: { legacy: LegacyConnectionSummary[]; now?: Date }) {
  const n = legacy.length;
  return (
    <Notice
      tone="info"
      data-testid="connections-legacy"
      title={n === 1 ? 'One older connection reaches a single workspace' : `${n} older connections each reach a single workspace`}
    >
      <ul className="mt-1 space-y-0.5">
        {legacy.map((l, i) => (
          <li key={i} className="text-body">
            {l.clientName} <span className="text-text-muted">· {l.workspaceName} · {lastActive(l.lastActiveAt, now)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-body">
        To move to one connection, run <code className="font-mono">buildd install --oauth</code> again.
      </p>
    </Notice>
  );
}

type Busy = null | 'workspaces' | 'access' | 'kind' | 'revoke';

function ConnectionItem({
  connection: c,
  teams,
  api,
  now,
  open,
  onToggle,
  onChange,
  onRevoked,
}: {
  connection: ConnectionSummary;
  teams: ConsentTeam[];
  api: ConnectionsApi;
  now?: Date;
  open: boolean;
  onToggle: () => void;
  onChange: (c: ConnectionSummary) => void;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState<null | 'kind' | 'revoke'>(null);

  async function save(kind: Exclude<Busy, null | 'revoke'>, body: PatchBody) {
    setBusy(kind);
    setError(null);
    const r = await api.patch(c.id, body);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    onChange(r.connection);
    return true;
  }

  async function revoke() {
    setBusy('revoke');
    setError(null);
    const r = await api.revoke(c.id);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onRevoked();
  }

  const only = c.workspaces.length === 1;

  return (
    <ConnectionRow
      testId="connection-row"
      title={c.clientName}
      chip={<StatusChip tone="idle">{c.actsAs === 'person' ? 'acts as you' : 'agent for you'}</StatusChip>}
      meta={connectionMeta(c, now)}
      open={open}
      onToggle={onToggle}
    >
      {error && <Notice tone="err" data-testid="connection-error">{error}</Notice>}

      <div className="space-y-1" data-testid="connection-kind">
        <p className="text-title font-semibold text-text-primary">{KIND_LABEL[c.actsAs]}</p>
        {c.actsAs === 'person' ? (
          <>
            <p className="text-body text-text-secondary">It can take the actions only a person may: force a review, override a landing, abandon work.</p>
            {confirm === 'kind' ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-body text-text-primary">Make it an agent? To undo this you would connect it again.</span>
                <button type="button" className="btn btn-sm h-11 md:h-8" onClick={() => setConfirm(null)} disabled={busy !== null}>Keep as you</button>
                <button
                  type="button"
                  data-testid="connection-make-agent-confirm"
                  className="btn btn-sm h-11 md:h-8"
                  disabled={busy !== null}
                  onClick={async () => { if (await save('kind', { actsAs: 'agent' })) setConfirm(null); }}
                >
                  {busy === 'kind' ? 'Saving…' : 'Make it an agent'}
                </button>
              </div>
            ) : (
              <button type="button" data-testid="connection-make-agent" className="btn btn-sm mt-1 h-11 md:h-8" onClick={() => setConfirm('kind')} disabled={busy !== null}>
                Make it an agent
              </button>
            )}
          </>
        ) : (
          <p className="text-body text-text-secondary">
            Its work is attributed to you, and actions only a person may take are refused. To let it act as you, connect the app again and agree when it asks.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-[var(--line-soft)] pt-3">
        <p className="text-title font-semibold text-text-primary">Permission</p>
        <Segmented<ConnectionAccess>
          label={`What ${c.clientName} can do`}
          value={c.access}
          items={[{ value: 'read', label: ACCESS_LABEL.read }, { value: 'read-write', label: ACCESS_LABEL['read-write'] }]}
          onChange={(access) => { if (access !== c.access && busy === null) void save('access', { access }); }}
        />
        <p className="text-meta text-text-muted">In each workspace it is also limited to your team role.</p>
      </div>

      <div className="space-y-2 border-t border-[var(--line-soft)] pt-3" data-testid="connection-workspaces">
        <div className="flex items-center justify-between gap-3">
          <p className="text-title font-semibold text-text-primary">Workspaces</p>
          {!picking && (
            <button type="button" data-testid="connection-change-workspaces" className="btn btn-sm h-11 md:h-8" onClick={() => setPicking(true)} disabled={busy !== null}>
              Add or remove
            </button>
          )}
        </div>
        {picking ? (
          <WorkspacePicker
            teams={teams}
            clientName={c.clientName}
            initialSelected={c.workspaces.map((w) => w.id)}
            saving={busy === 'workspaces'}
            onCancel={() => setPicking(false)}
            onSave={async (selected) => {
              const { add, remove } = selectionChange(c.workspaces.map((w) => w.id), selected);
              if (add.length === 0 && remove.length === 0) { setPicking(false); return; }
              if (await save('workspaces', { addWorkspaceIds: add, removeWorkspaceIds: remove })) setPicking(false);
            }}
          />
        ) : (
          <>
            {byTeam(c.workspaces).map((g) => (
              <div key={g.teamId}>
                <p className="text-meta text-text-muted">{g.teamName}</p>
                <ul className="divide-y divide-[var(--line-soft)]">
                  {g.workspaces.map((w) => (
                    <li key={w.id} className="flex min-h-11 items-center justify-between gap-3" data-testid="connection-workspace">
                      <span className="min-w-0 break-words text-body text-text-primary">{w.name}</span>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm h-11 md:h-8"
                        disabled={busy !== null || only}
                        title={only ? 'A connection needs one workspace. Revoke it instead.' : undefined}
                        aria-label={`Remove ${w.name}`}
                        onClick={() => void save('workspaces', { removeWorkspaceIds: [w.id] })}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {c.unreachableCount > 0 && (
              <p className="text-meta text-text-muted">
                {c.unreachableCount === 1 ? 'One more workspace is' : `${c.unreachableCount} more workspaces are`} out of reach: you are no longer on {c.unreachableCount === 1 ? 'its team' : 'their teams'}.
              </p>
            )}
          </>
        )}
      </div>

      <div className="border-t border-[var(--line-soft)] pt-3">
        {confirm === 'revoke' ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="connection-revoke-confirm">
            <span className="text-body text-text-primary">Revoke {c.clientName}? It stops working on its next request, and signing in again starts over.</span>
            <button type="button" className="btn btn-sm h-11 md:h-8" onClick={() => setConfirm(null)} disabled={busy !== null}>Keep it</button>
            <button type="button" data-testid="connection-revoke-yes" className="btn btn-danger btn-sm h-11 md:h-8" onClick={() => void revoke()} disabled={busy !== null}>
              {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        ) : (
          <button type="button" data-testid="connection-revoke" className="btn btn-danger btn-sm h-11 md:h-8" onClick={() => setConfirm('revoke')} disabled={busy !== null}>
            Revoke
          </button>
        )}
      </div>
    </ConnectionRow>
  );
}
