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

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.error === 'string' && body.error ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export default function RunnerKeysSection({ keys: initialKeys, foreign: initialForeign }: { keys: RunnerKeySummary[]; foreign: ForeignRunner[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [foreign, setForeign] = useState(initialForeign);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The row whose destructive action is waiting on a second tap. */
  const [confirm, setConfirm] = useState<string | null>(null);

  async function disconnect(k: RunnerKeySummary) {
    setBusy(k.id);
    setError(null);
    const res = await fetch(`/api/accounts/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
    setBusy(null);
    setConfirm(null);
    if (!res.ok) return setError(await errorOf(res, 'Could not disconnect it. Try again.'));
    setKeys((list) => list.filter((x) => x.id !== k.id));
  }

  async function removeForeign(r: ForeignRunner) {
    const id = `${r.accountId}:${r.workspaceId}`;
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/workspaces/${encodeURIComponent(r.workspaceId)}/accounts?accountId=${encodeURIComponent(r.accountId)}`, { method: 'DELETE' });
    setBusy(null);
    setConfirm(null);
    if (!res.ok) return setError(await errorOf(res, 'Could not remove it. Try again.'));
    setForeign((list) => list.filter((x) => !(x.accountId === r.accountId && x.workspaceId === r.workspaceId)));
  }

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
                  <p className="text-meta text-text-muted">Claims from the open workspaces of {k.homeTeamName}. Edit to choose workspaces.</p>
                ) : (
                  groupPicks(k.picks).map((g) => (
                    <div key={g.teamId}>
                      <p className="text-meta text-text-muted">{g.teamName}</p>
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
                  ))
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Runners from other teams" count={foreign.length}>
        {foreign.length > 0 && (
          <ul className={ROWS} data-testid="foreign-runners">
            {foreign.map((r) => {
              const id = `${r.accountId}:${r.workspaceId}`;
              return (
                <li key={id} className="space-y-2 py-2" data-testid="foreign-runner-row">
                  <div className="flex min-h-11 items-center justify-between gap-3">
                    <span className="min-w-0 break-words text-body text-text-primary">
                      {r.workspaceName}
                      <span className="block text-meta text-text-muted">
                        {r.accountName}, connected by {r.ownerName}, home team {r.homeTeamName}
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
                      question={`Remove ${r.accountName} from ${r.workspaceName}? That runner stops claiming work in this workspace.`}
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
        )}
      </Section>
    </div>
  );
}
