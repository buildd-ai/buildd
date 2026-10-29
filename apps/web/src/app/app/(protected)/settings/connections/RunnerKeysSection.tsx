'use client';

/**
 * Settings → Connected apps → Runners (spec "One runner for every team you
 * run", R-4): the runner keys this person made with `buildd login`, each with
 * the workspaces it claims from, grouped by team. Edit reopens the runner
 * consent page with the current picks (the key stays the same); Disconnect
 * deletes the key, after the same inline confirm the app rows use. A pick the person can no longer reach (they left the team,
 * or lost the role a restricted workspace needs) says so: the runner stops
 * claiming there on its next claim.
 *
 * Below it, for a person who owns or administers a team: runners from other
 * teams that reach that team's workspaces, with who connected them, and
 * Remove to take one off a workspace, also asked first.
 */
import { useState } from 'react';
import Section from '@/components/ui/Section';
import InlineConfirm from './InlineConfirm';
import type { ForeignRunner, RunnerKeySummary } from '@/lib/runner-picks';

/** Workspace groups shown before the rest sit behind "Show all". */
const FOREIGN_GROUPS_SHOWN = 5;

const ROWS = 'divide-y divide-border-default border-y border-border-default';

function groupPicks(picks: NonNullable<RunnerKeySummary['picks']>) {
  const groups = new Map<string, { teamName: string; picks: typeof picks }>();
  for (const p of picks) {
    const g = groups.get(p.teamId) ?? { teamName: p.teamName, picks: [] };
    g.picks.push(p);
    groups.set(p.teamId, g);
  }
  return [...groups.entries()].map(([teamId, g]) => ({ teamId, ...g }));
}

/** One disclosure per workspace, so the same name is not repeated down the page. */
function groupForeign(foreign: ForeignRunner[]) {
  const groups = new Map<string, { workspaceId: string; workspaceName: string; runners: ForeignRunner[] }>();
  for (const r of foreign) {
    const g = groups.get(r.workspaceId) ?? { workspaceId: r.workspaceId, workspaceName: r.workspaceName, runners: [] };
    g.runners.push(r);
    groups.set(r.workspaceId, g);
  }
  return [...groups.values()];
}

/** The two calls the section makes. The dev fixture swaps in a local one. */
export interface RunnerKeysApi {
  disconnect(accountId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  removeForeign(r: ForeignRunner): Promise<{ ok: true } | { ok: false; error: string }>;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.error === 'string' && body.error ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export const fetchRunnerKeysApi: RunnerKeysApi = {
  async disconnect(accountId) {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    return res.ok ? { ok: true } : { ok: false, error: await errorOf(res, 'Could not disconnect it. Try again.') };
  },
  async removeForeign(r) {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(r.workspaceId)}/accounts?accountId=${encodeURIComponent(r.accountId)}`, { method: 'DELETE' });
    return res.ok ? { ok: true } : { ok: false, error: await errorOf(res, 'Could not remove it. Try again.') };
  },
};

export default function RunnerKeysSection({
  keys: initialKeys,
  foreign: initialForeign,
  api = fetchRunnerKeysApi,
}: {
  keys: RunnerKeySummary[];
  foreign: ForeignRunner[];
  api?: RunnerKeysApi;
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [foreign, setForeign] = useState(initialForeign);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllForeign, setShowAllForeign] = useState(false);
  /** The row whose destructive action is waiting on a second tap. */
  const [confirm, setConfirm] = useState<string | null>(null);

  async function disconnect(k: RunnerKeySummary) {
    setBusy(k.id);
    setError(null);
    const r = await api.disconnect(k.id);
    setBusy(null);
    setConfirm(null);
    if (!r.ok) return setError(r.error);
    setKeys((list) => list.filter((x) => x.id !== k.id));
  }

  async function removeForeign(r: ForeignRunner) {
    const id = `${r.accountId}:${r.workspaceId}`;
    setBusy(id);
    setError(null);
    const res = await api.removeForeign(r);
    setBusy(null);
    setConfirm(null);
    if (!res.ok) return setError(res.error);
    setForeign((list) => list.filter((x) => !(x.accountId === r.accountId && x.workspaceId === r.workspaceId)));
  }

  const foreignGroups = groupForeign(foreign);

  return (
    <div data-testid="runner-keys">
      {error && <p role="alert" className="mb-3 text-body text-status-error">{error}</p>}
      <Section title="Your runners" count={keys.length}>
        {keys.length === 0 ? (
          <p className="text-body text-text-muted" data-testid="runner-keys-empty">
            No runners. Run <code className="font-mono">buildd login</code> on a machine to connect one.
          </p>
        ) : (
          <div className={ROWS}>
            {keys.map((k) => (
              <div key={k.id} className="space-y-2 py-3" data-testid="runner-key-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="text-sm font-semibold text-text-primary">{k.name}</span>
                    <span className="ml-2 font-mono text-meta text-text-muted">{k.apiKeyPrefix ?? ''}</span>
                    <span className="block text-meta text-text-muted">Limits count in {k.homeTeamName}</span>
                  </span>
                  {confirm !== k.id && (
                    <span className="flex gap-2">
                      <a className="btn btn-sm h-11 md:h-8" href={`/api/auth/runner-picks?account=${encodeURIComponent(k.id)}`} data-testid="runner-key-edit">
                        Edit
                      </a>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm h-11 md:h-8"
                        disabled={busy !== null}
                        onClick={() => setConfirm(k.id)}
                        data-testid="runner-key-disconnect"
                      >
                        Disconnect
                      </button>
                    </span>
                  )}
                </div>
                {confirm === k.id && (
                  <InlineConfirm
                    testId="runner-key-disconnect-confirm"
                    confirmTestId="runner-key-disconnect-yes"
                    question={<>Disconnect {k.name}? The runner on that machine stops until someone runs <code className="font-mono">buildd login</code> there again.</>}
                    confirmLabel="Disconnect"
                    busyLabel="Disconnecting…"
                    busy={busy === k.id}
                    disabled={busy !== null}
                    onKeep={() => setConfirm(null)}
                    onConfirm={() => void disconnect(k)}
                  />
                )}
                {k.picks == null ? (
                  <p className="text-meta text-text-muted">Takes work from the open workspaces of {k.homeTeamName}. Edit to choose workspaces.</p>
                ) : (
                  <details className="group" data-testid="runner-key-picks">
                    <summary className="flex min-h-11 cursor-pointer items-center text-meta text-text-muted md:min-h-8">
                      {k.picks.length} {k.picks.length === 1 ? 'workspace' : 'workspaces'}
                    </summary>
                    {groupPicks(k.picks).map((g) => (
                      <div key={g.teamId}>
                        <p className="text-meta text-text-muted" data-testid="runner-key-team">{g.teamName}</p>
                        <ul className="divide-y divide-[var(--line-soft)]">
                          {g.picks.map((p) => (
                            <li key={p.workspaceId} className="flex min-h-11 items-center justify-between gap-3" data-testid="runner-key-pick" data-reachable={p.reachable}>
                              <span className="min-w-0 break-words text-body text-text-primary">{p.workspaceName}</span>
                              {p.removedByAdmin
                                ? <span className="text-meta text-text-muted">Removed by a team admin</span>
                                : !p.reachable && <span className="text-meta text-text-muted">No longer reachable</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Runners from other teams" count={foreign.length}>
        {foreign.length > 0 && (
          <div className="space-y-2" data-testid="foreign-runners">
            {(showAllForeign ? foreignGroups : foreignGroups.slice(0, FOREIGN_GROUPS_SHOWN)).map((g) => {
              return (
              <details key={g.workspaceId} className="group" open={foreignGroups.length === 1} data-testid="foreign-runner-group">
                <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-body text-text-primary md:min-h-8">
                  <span className="min-w-0 break-words">{g.workspaceName}</span>
                  <span className="shrink-0 text-meta text-text-muted">{g.runners.length} {g.runners.length === 1 ? 'runner' : 'runners'}</span>
                </summary>
                <ul className={ROWS}>
                  {g.runners.map((r) => {
                    const id = `${r.accountId}:${r.workspaceId}`;
                    return (
                      <li key={id} className="space-y-2 py-2" data-testid="foreign-runner-row">
                        <div className="flex min-h-11 items-center justify-between gap-3">
                          <span className="min-w-0 break-words text-body text-text-primary">
                            {r.accountName}
                            <span className="block text-meta text-text-muted">
                              connected by {r.ownerName}, home team {r.homeTeamName}
                            </span>
                          </span>
                          {confirm !== id && (
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm h-11 md:h-8"
                              disabled={busy !== null}
                              aria-label={`Remove ${r.accountName} from ${r.workspaceName}`}
                              onClick={() => setConfirm(id)}
                              data-testid="foreign-runner-remove"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        {confirm === id && (
                          <InlineConfirm
                            testId="foreign-runner-remove-confirm"
                            confirmTestId="foreign-runner-remove-yes"
                            question={`Remove ${r.accountName} from ${r.workspaceName}? That runner stops taking work from this workspace.`}
                            confirmLabel="Remove"
                            busyLabel="Removing…"
                            busy={busy === id}
                            disabled={busy !== null}
                            onKeep={() => setConfirm(null)}
                            onConfirm={() => void removeForeign(r)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
              );
            })}
            {!showAllForeign && foreignGroups.length > FOREIGN_GROUPS_SHOWN && (
              <button type="button" className="btn btn-quiet btn-sm h-11 md:h-8" onClick={() => setShowAllForeign(true)} data-testid="foreign-runners-show-all">
                Show all {foreignGroups.length} workspaces
              </button>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
