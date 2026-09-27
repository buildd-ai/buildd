'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { formatPhaseLabel } from '@/lib/migration-outcomes';
import { openInTeam } from '@/lib/switch-team';

// Redeclared locally: @/lib/workspace-migration is server-only db code.
type Disposition = 'MOVES_CLEANLY' | 'NEEDS_RE_ENTRY' | 'NEEDS_RE_AUTH' | 'WILL_BREAK' | 'LEFT_BEHIND';

interface DryRunItem { key: string; label: string; disposition: Disposition }
interface DryRunGroup { entity: string; disposition: Disposition; count: number; items?: DryRunItem[] }
interface DryRunReport {
  precheck: { status: 'PASS' | 'FAIL'; githubApp: { ok: boolean; message?: string } };
  groups: DryRunGroup[];
  requiredAcks: string[];
}

export interface MoveWorkspace { id: string; name: string; teamId: string }
export interface MoveTeam { id: string; name: string }

/** A check is only good for the destination it ran against. */
type Check =
  | { teamId: string; state: 'checking' }
  | { teamId: string; state: 'ok'; report: DryRunReport; token: string }
  | { teamId: string; state: 'blocked'; reason: string };

const PANEL =
  'card w-full max-w-[calc(100vw-2rem)] sm:max-w-md mx-4 max-h-[85vh] overflow-y-auto outline-none';

const GITHUB_BLOCKED = 'Blocked: GitHub App missing or suspended.';

/** What the user loses, per kind, as [entity, singular, plural]. Order is display order. */
const LOSSES: Array<[string, string, string]> = [
  ['Connectors', 'connector needs reconnecting', 'connectors need reconnecting'],
  ['Secrets (workspace-scoped)', 'workspace secret removed', 'workspace secrets removed'],
  ['Account Access', 'runner account loses access', 'runner accounts lose access'],
  ['Mission dependency chains', 'mission dependency breaks', 'mission dependencies break'],
  ['Role delegation chains', 'role delegation breaks', 'role delegations break'],
];

/**
 * The dry run as one line, e.g. "2 connectors need reconnecting · 1 workspace
 * secret removed". Empty when the move costs nothing.
 */
export function consequenceLine(groups: DryRunGroup[]): string {
  return LOSSES.flatMap(([entity, one, many]) => {
    const n = groups
      .filter((g) => g.entity === entity && g.disposition !== 'MOVES_CLEANLY' && g.disposition !== 'LEFT_BEHIND')
      .reduce((sum, g) => sum + (g.items?.length ?? g.count), 0);
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  }).join(' · ');
}

/**
 * Move a workspace to another team. Picking a team runs POST /migrate/precheck
 * (the dry run) straight away; Move (POST /migrate/execute) is enabled only by
 * a passing check for the team currently picked. The check's result is the
 * confirmation: Move sends every required item as confirmed.
 */
export default function MoveToTeamDialog({
  workspace,
  teams,
  onClose,
  onMoved,
}: {
  workspace: MoveWorkspace;
  teams: MoveTeam[];
  onClose: () => void;
  onMoved: (team: MoveTeam) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const destinations = useMemo(() => teams.filter((t) => t.id !== workspace.teamId), [teams, workspace.teamId]);
  const [teamId, setTeamId] = useState(destinations.length === 1 ? destinations[0].id : '');
  const [check, setCheck] = useState<Check | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairRunId, setRepairRunId] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(0);
  const latest = useRef(teamId);
  latest.current = teamId;

  useEffect(() => {
    if (!teamId) return;
    setCheck({ teamId, state: 'checking' });
    (async () => {
      let next: Check;
      try {
        const res = await fetch(`/api/workspaces/${workspace.id}/migrate/precheck`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ destinationTeamId: teamId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.report) {
          next = { teamId, state: 'blocked', reason: data.error || 'Could not check this move.' };
        } else if (data.report.precheck.status === 'FAIL') {
          next = { teamId, state: 'blocked', reason: data.report.precheck.githubApp?.ok === false ? GITHUB_BLOCKED : 'Blocked by the precheck.' };
        } else {
          next = { teamId, state: 'ok', report: data.report as DryRunReport, token: data.dryRunToken as string };
        }
      } catch {
        next = { teamId, state: 'blocked', reason: 'Could not check this move.' };
      }
      // A slow answer for a team no longer picked is dropped.
      if (latest.current === teamId) setCheck(next);
    })();
  }, [teamId, workspace.id, recheck]);

  const current = check && check.teamId === teamId ? check : null;
  const ready = current?.state === 'ok' ? current : null;
  const busy = moving;
  const consequences = ready ? consequenceLine(ready.report.groups) : '';
  const team = teams.find((t) => t.id === teamId);

  function pickTeam(next: string) {
    setTeamId(next);
    setError(null);
  }

  async function post(path: 'execute' | 'repair', body: unknown) {
    const res = await fetch(`/api/workspaces/${workspace.id}/migrate/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  function done() {
    router.refresh();
    if (team) onMoved(team);
  }

  async function runMove() {
    if (!ready) return;
    setMoving(true);
    setError(null);
    try {
      const { res, data } = await post('execute', {
        destinationTeamId: ready.teamId,
        dryRunToken: ready.token,
        confirmedItems: ready.report.requiredAcks,
      });
      if (res.ok) {
        done();
        return;
      }
      if (res.status === 500 && data.error === 'migration_failed') {
        setRepairRunId(data.runId ?? null);
        setError(`Move failed${data.phase ? ` at ${formatPhaseLabel(data.phase)}` : ''}${data.message ? `: ${data.message}` : ''}`);
      } else if (['invalid_token', 'precheck_failed', 'unconfirmed_items'].includes(data.error)) {
        // Something changed since the check: check again rather than ask the user to.
        setRecheck((n) => n + 1);
      } else {
        setError(data.error || 'Move failed');
      }
    } catch {
      setError('Move failed');
    } finally {
      setMoving(false);
    }
  }

  async function runRepair() {
    if (!repairRunId) return;
    setMoving(true);
    setError(null);
    try {
      const { res, data } = await post('repair', { runId: repairRunId });
      if (res.ok) done();
      else setError(data.error || 'Repair failed');
    } catch {
      setError('Repair failed');
    } finally {
      setMoving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} dismissible={!busy} className={PANEL}>
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-[15px] font-semibold text-text-primary min-w-0 break-words">
            Move {workspace.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div>
          <label htmlFor={`${titleId}-team`} className="field-label">To team</label>
          <Select
            id={`${titleId}-team`}
            aria-label="Destination team"
            value={teamId}
            onChange={pickTeam}
            placeholder="Pick a team"
            disabled={busy || repairRunId !== null}
            options={destinations.map((t) => ({ value: t.id, label: t.name }))}
            className="w-full"
          />
        </div>

        <div className="min-h-5 text-[13px]" aria-live="polite">
          {error ? (
            <p className="text-status-error" role="alert">{error}</p>
          ) : current?.state === 'checking' ? (
            <p className="text-text-muted">Checking&hellip;</p>
          ) : current?.state === 'blocked' ? (
            <p className="text-status-error" data-testid="move-blocked">{current.reason}</p>
          ) : consequences ? (
            <p className="text-status-warning" data-testid="move-consequences">{consequences}</p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-lg btn-quiet">
            Cancel
          </button>
          {repairRunId ? (
            <button type="button" onClick={runRepair} disabled={busy} className="btn btn-lg btn-primary">
              {moving ? 'Repairing…' : 'Repair'}
            </button>
          ) : (
            <button type="button" onClick={runMove} disabled={!ready || busy} className="btn btn-lg btn-primary">
              {moving ? 'Moving…' : 'Move'}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const TOAST_MS = 10_000;

/** After a move: which workspace went where, with a link that opens it in that team. */
export function MovedToast({
  workspace,
  team,
  onDismiss,
}: {
  workspace: MoveWorkspace;
  team: MoveTeam;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);
  const href = `/app/workspaces/${workspace.id}`;

  return (
    <div
      role="status"
      data-testid="move-toast"
      className="fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-md items-center gap-3 border-2 border-border-strong bg-card px-4 py-2 text-[13px] text-text-primary shadow-[3px_3px_0_0_var(--accent)] md:bottom-6"
    >
      <span className="min-w-0 flex-1 break-words">Moved {workspace.name} to {team.name}.</span>
      <a
        href={href}
        onClick={(e) => { e.preventDefault(); openInTeam(team.id, href); }}
        className="inline-flex min-h-11 md:min-h-0 shrink-0 items-center font-semibold text-accent-text underline underline-offset-4"
      >
        Open
      </a>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-2 flex h-11 w-11 md:h-8 md:w-8 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The move flow for any entry point: `start(workspace, teams)` opens the
 * dialog, and `ui` renders it plus the toast. Mount `ui` above anything that
 * disappears when the workspace leaves the current team (a list row), so the
 * toast survives the refresh.
 */
export function useMoveToTeam() {
  const [moving, setMoving] = useState<{ workspace: MoveWorkspace; teams: MoveTeam[] } | null>(null);
  const [moved, setMoved] = useState<{ workspace: MoveWorkspace; team: MoveTeam } | null>(null);
  const start = useCallback((workspace: MoveWorkspace, teams: MoveTeam[]) => {
    setMoved(null);
    setMoving({ workspace, teams });
  }, []);
  const dismiss = useCallback(() => setMoved(null), []);

  const ui = (
    <>
      {moving && (
        <MoveToTeamDialog
          workspace={moving.workspace}
          teams={moving.teams}
          onClose={() => setMoving(null)}
          onMoved={(team) => {
            setMoved({ workspace: moving.workspace, team });
            setMoving(null);
          }}
        />
      )}
      {moved && <MovedToast workspace={moved.workspace} team={moved.team} onDismiss={dismiss} />}
    </>
  );
  return { start, ui };
}

/** "Move to team…" button that owns the flow. */
export function MoveToTeamButton({
  workspace,
  teams,
  className = 'btn min-h-11',
}: {
  workspace: MoveWorkspace;
  teams: MoveTeam[];
  className?: string;
}) {
  const { start, ui } = useMoveToTeam();
  return (
    <>
      <button type="button" onClick={() => start(workspace, teams)} className={className} aria-haspopup="dialog">
        Move to team&hellip;
      </button>
      {ui}
    </>
  );
}
