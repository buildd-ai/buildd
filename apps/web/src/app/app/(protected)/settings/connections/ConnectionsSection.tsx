'use client';

/**
 * Settings → Connected apps: the MCP apps the signed-in person connected to
 * buildd (docs/specs/auth-oauth-boundaries.md, "Managing connections").
 *
 * Each connection is one hairline row: the app's name, whether it acts as the
 * person or as their agent, and one line of meta. Opening a row shows, team by
 * team, what it reaches and how (all current and future workspaces, or
 * specific ones), and every change it allows: edit a team's access (the
 * consent page's picker for specific workspaces), add a team, remove a
 * specific workspace, read only or read and write, make it an agent, revoke.
 * A connection that is an agent cannot be made to act as the person here;
 * that takes a fresh consent.
 *
 * Every change goes to /api/mcp-grants with the revision it was made against,
 * and applies on the app's next request. A change made against an older
 * revision is refused; the page then shows the connection as it is now and
 * keeps the person's edit open to review again.
 */
import { useState } from 'react';
import type { TeamModeChange } from '@/lib/mcp-grant-patch';
import ConnectionRow, { StatusChip } from '../_components/ConnectionRow';
import Disclosure from '@/components/ui/Disclosure';
import Notice from '@/components/ui/Notice';
import Segmented from '@/components/ui/Segmented';
import Section from '@/components/ui/Section';
import type { ConsentTeam } from '@/lib/oauth/account-consent';
import type { ConnectionAccess, ConnectionSummary, LegacyConnectionSummary } from '@/lib/mcp-grant-patch';
import InlineConfirm from './InlineConfirm';
import TeamAccessEditor from './TeamAccessEditor';
import { ACCESS_LABEL, KIND_LABEL, MODE_LABEL, connectionMeta, lastActive, savedMessage } from './connections-view';

export interface ConnectionsData {
  connections: ConnectionSummary[];
  legacy: LegacyConnectionSummary[];
  teams: ConsentTeam[];
}

export type PatchBody = {
  addWorkspaceIds?: string[];
  removeWorkspaceIds?: string[];
  teams?: TeamModeChange[];
  access?: ConnectionAccess;
  actsAs?: 'agent';
  ifRevision?: number;
};

export type PatchFailure = { ok: false; error: string; code?: string; connection?: ConnectionSummary };

/** The two calls the section makes. The dev fixture swaps in a local one. */
export interface ConnectionsApi {
  patch(id: string, body: PatchBody): Promise<{ ok: true; connection: ConnectionSummary } | PatchFailure>;
  revoke(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

async function failureOf(res: Response, fallback: string): Promise<PatchFailure> {
  try {
    const body = await res.json();
    return {
      ok: false,
      error: typeof body?.error === 'string' && body.error ? body.error : fallback,
      ...(typeof body?.code === 'string' ? { code: body.code } : {}),
      ...(body?.connection && typeof body.connection === 'object' ? { connection: body.connection as ConnectionSummary } : {}),
    };
  } catch {
    return { ok: false, error: fallback };
  }
}

export const fetchConnectionsApi: ConnectionsApi = {
  async patch(id, body) {
    let res: Response;
    try {
      res = await fetch(`/api/mcp-grants/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, error: 'Could not reach buildd. Check your connection and try again.' };
    }
    if (!res.ok) return failureOf(res, 'Could not save the change. Try again.');
    return { ok: true, connection: (await res.json()).connection };
  },
  async revoke(id) {
    let res: Response;
    try {
      res = await fetch(`/api/mcp-grants/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      return { ok: false, error: 'Could not reach buildd. Check your connection and try again.' };
    }
    if (!res.ok) return { ok: false, error: (await failureOf(res, 'Could not revoke it. Try again.')).error };
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
    <div>
      <Section title="Your apps" count={connections.length}>
        {connections.length === 0 ? (
          <p className="text-body text-text-muted" data-testid="connections-empty">
            {revoked ? `${revoked} is disconnected. ` : ''}No apps. Add buildd as an MCP server in an app such as Claude or Cursor.
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
        {initial.legacy.length > 0 && <LegacyConnections legacy={initial.legacy} now={now} />}
      </Section>
    </div>
  );
}

/**
 * Connections made before one connection could reach several workspaces: each
 * reaches one. Folded, since there is nothing to do here: connecting the app
 * again replaces them.
 */
function LegacyConnections({ legacy, now }: { legacy: LegacyConnectionSummary[]; now?: Date }) {
  return (
    <div data-testid="connections-legacy" className="mt-2">
    <Disclosure summary="Older connections" count={legacy.length}>
      <ul className="divide-y divide-[var(--line-soft)] pb-2">
        {legacy.map((l, i) => (
          <li key={i} className="py-2 text-body text-text-primary">
            {l.clientName} <span className="text-text-muted">· {l.workspaceName} · {lastActive(l.lastActiveAt, now)}</span>
          </li>
        ))}
      </ul>
      <p className="pb-2 text-meta text-text-muted">Each reaches one workspace. Connecting the app again replaces them.</p>
    </Disclosure>
    </div>
  );
}

type Busy = null | 'workspaces' | 'access' | 'kind' | 'revoke' | 'team';

/** A team being edited: its id, and where the editor starts. */
type Editing = { teamId: string; start?: 'all' };

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
  const [editError, setEditError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<null | 'kind' | 'revoke'>(null);

  /** One request at a time per connection, sent with the revision on screen. */
  async function save(kind: Exclude<Busy, null | 'revoke'>, body: PatchBody, onError: (e: string) => void = setError) {
    if (busy !== null) return false;
    setBusy(kind);
    setError(null);
    setEditError(null);
    setSaved(null);
    const r = await api.patch(c.id, { ...body, ifRevision: c.revision });
    setBusy(null);
    if (!r.ok) {
      // Someone (another tab, another device) changed it first: show what it
      // is now and let the person look again, never overwrite it.
      if (r.connection) onChange(r.connection);
      onError(r.error);
      return false;
    }
    onChange(r.connection);
    setSaved(savedMessage(c.clientName));
    return true;
  }

  const editable = teams.filter((t) => t.workspaces.some((w) => !w.system));
  const addable = editable.filter((t) => !c.teams.some((x) => x.teamId === t.id));
  const editingTeam = editing ? teams.find((t) => t.id === editing.teamId) ?? null : null;

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
            <p className="text-body text-text-secondary">It can take the actions only a person may: force a review, override a merge, abandon work.</p>
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

      <div className="space-y-3 border-t border-[var(--line-soft)] pt-3" data-testid="connection-workspaces">
        <div>
          <p className="text-title font-semibold text-text-primary">Teams and workspaces</p>
          <p className="text-meta text-text-muted">What {c.clientName} can reach, team by team. Changes apply on its next request.</p>
        </div>
        {saved && <p className="text-body text-text-secondary" role="status" data-testid="connection-saved">{saved}</p>}
        {c.teams.map((t) => {
          const isEditing = editing?.teamId === t.teamId && editingTeam;
          return (
            <div key={t.teamId} className="space-y-1" data-testid="connection-team" data-team={t.teamId} data-mode={t.mode}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="break-words text-body font-semibold text-text-primary">{t.teamName}</p>
                  <p className="text-meta text-text-muted" data-testid="connection-team-mode">
                    {t.mode === 'all'
                      ? `${MODE_LABEL.all} · ${t.workspaces.length} now`
                      : `${MODE_LABEL.specific} · ${t.workspaces.length}`}
                  </p>
                </div>
                {!isEditing && (
                  <button
                    type="button"
                    data-testid="connection-team-edit"
                    className="btn btn-sm h-11 md:h-8"
                    disabled={busy !== null || !teams.some((x) => x.id === t.teamId)}
                    aria-label={`Edit access to ${t.teamName}`}
                    onClick={() => { setEditing({ teamId: t.teamId }); setAdding(false); setEditError(null); setSaved(null); }}
                  >
                    Edit access
                  </button>
                )}
              </div>
              {isEditing ? (
                <TeamAccessEditor
                  connection={c}
                  team={editingTeam}
                  saving={busy === 'team'}
                  error={editError}
                  onCancel={() => { setEditing(null); setEditError(null); }}
                  onSave={async (change) => { if (await save('team', { teams: [change] }, setEditError)) setEditing(null); }}
                />
              ) : t.mode === 'all' ? (
                <>
                  <Disclosure summary={`${t.workspaces.length === 1 ? '1 workspace' : `${t.workspaces.length} workspaces`} it reaches now`}>
                    <ul className="divide-y divide-[var(--line-soft)] pb-2">
                      {t.workspaces.map((w) => (
                        <li key={w.id} className="flex min-h-11 items-center text-body text-text-primary" data-testid="connection-workspace">{w.name}</li>
                      ))}
                    </ul>
                  </Disclosure>
                  <p className="text-meta text-text-muted">
                    Workspaces created in or moved into {t.teamName} later are included. To leave one out, edit access and choose specific workspaces.
                  </p>
                </>
              ) : (
                <ul className="divide-y divide-[var(--line-soft)]">
                  {t.workspaces.map((w) => (
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
              )}
            </div>
          );
        })}

        {editing && editingTeam && !c.teams.some((t) => t.teamId === editing.teamId) && (
          <TeamAccessEditor
            connection={c}
            team={editingTeam}
            initialChoice={editing.start}
            saving={busy === 'team'}
            error={editError}
            onCancel={() => { setEditing(null); setEditError(null); }}
            onSave={async (change) => { if (await save('team', { teams: [change] }, setEditError)) setEditing(null); }}
          />
        )}

        {!editing && addable.length > 0 && (
          adding ? (
            <div className="space-y-2" data-testid="connection-add-team">
              <p className="text-body text-text-secondary">Which team should {c.clientName} reach?</p>
              <ul className="divide-y divide-[var(--line-soft)] border-y border-[var(--line-soft)]">
                {addable.map((t) => (
                  <li key={t.id} className="flex min-h-11 items-center justify-between gap-3">
                    <span className="min-w-0 break-words text-body text-text-primary">{t.name}</span>
                    <button
                      type="button"
                      className="btn btn-sm h-11 md:h-8"
                      aria-label={`Choose access to ${t.name}`}
                      onClick={() => { setEditing({ teamId: t.id, start: 'all' }); setAdding(false); setSaved(null); }}
                    >
                      Choose access
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" data-testid="connection-add-team-open" className="btn btn-sm h-11 md:h-8" disabled={busy !== null} onClick={() => { setAdding(true); setSaved(null); }}>
              Add a team
            </button>
          )
        )}

        {c.unreachableCount > 0 && (
          <p className="text-meta text-text-muted">
            {c.unreachableCount === 1 ? 'One more workspace is' : `${c.unreachableCount} more workspaces are`} out of reach: you are no longer on {c.unreachableCount === 1 ? 'its team' : 'their teams'}.
          </p>
        )}
        {c.unreachableTeamCount > 0 && (
          <p className="text-meta text-text-muted">
            {c.unreachableTeamCount === 1 ? 'One team you left is' : `${c.unreachableTeamCount} teams you left are`} out of reach. Rejoining gives the app access there again.
          </p>
        )}
      </div>

      <div className="border-t border-[var(--line-soft)] pt-3">
        {confirm === 'revoke' ? (
          <InlineConfirm
            testId="connection-revoke-confirm"
            confirmTestId="connection-revoke-yes"
            question={`Revoke ${c.clientName}? It stops working on its next request, and signing in again starts over.`}
            confirmLabel="Revoke"
            busyLabel="Revoking…"
            busy={busy === 'revoke'}
            disabled={busy !== null}
            onKeep={() => setConfirm(null)}
            onConfirm={() => void revoke()}
          />
        ) : (
          <button type="button" data-testid="connection-revoke" className="btn btn-danger btn-sm h-11 md:h-8" onClick={() => setConfirm('revoke')} disabled={busy !== null}>
            Revoke
          </button>
        )}
      </div>
    </ConnectionRow>
  );
}
