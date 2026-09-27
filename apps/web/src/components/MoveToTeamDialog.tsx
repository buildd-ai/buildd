'use client';

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/components/ui/Dialog';
import { formatOutcomeDetail, formatPhaseLabel, isPhaseSuccess } from '@/lib/migration-outcomes';

// Redeclared locally: @/lib/workspace-migration is server-only db code.
type Disposition = 'MOVES_CLEANLY' | 'NEEDS_RE_ENTRY' | 'NEEDS_RE_AUTH' | 'WILL_BREAK' | 'LEFT_BEHIND';

interface DryRunItem { key: string; label: string; disposition: Disposition }
interface DryRunGroup { entity: string; disposition: Disposition; count: number; detail?: string; items?: DryRunItem[] }
interface DryRunReport {
  sourceTeamName: string;
  destinationTeamName: string;
  precheck: { status: 'PASS' | 'FAIL'; githubApp: { ok: boolean; message?: string } };
  groups: DryRunGroup[];
  requiredAcks: string[];
}
interface Outcome { phase: string; status: string; detail?: unknown }

export interface MoveWorkspace { id: string; name: string; teamId: string }
export interface MoveTeam { id: string; name: string }

/** A check is only good for the destination it ran against. */
interface Check { teamId: string; report: DryRunReport; token: string }

type Result = { ok: true; outcomes: Outcome[] } | { ok: false; outcomes: Outcome[]; repairRunId: string | null };

const PANEL =
  'card w-full max-w-[calc(100vw-2rem)] sm:max-w-lg mx-4 max-h-[85vh] overflow-y-auto outline-none';

function itemsOf(groups: DryRunGroup[], d: Disposition): string[] {
  return groups.flatMap((g) => (g.items ?? []).filter((i) => i.disposition === d).map((i) => i.label));
}

function counted(groups: DryRunGroup[], d: Disposition): Array<[string, number]> {
  return groups.filter((g) => g.disposition === d && g.count > 0).map((g) => [g.entity, g.count]);
}

function ResultRow({ label, tone, children }: { label: string; tone?: 'warn' | 'error'; children: React.ReactNode }) {
  const color = tone === 'error' ? 'text-status-error' : tone === 'warn' ? 'text-status-warning' : 'text-text-muted';
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
      <dt className={`section-label ${color}`}>{label}</dt>
      <dd className="text-[13px] text-text-primary min-w-0">{children}</dd>
    </div>
  );
}

function CheckResult({ report }: { report: DryRunReport }) {
  const moves = counted(report.groups, 'MOVES_CLEANLY');
  const deleted = itemsOf(report.groups, 'NEEDS_RE_ENTRY');
  const reauth = itemsOf(report.groups, 'NEEDS_RE_AUTH');
  const breaks = itemsOf(report.groups, 'WILL_BREAK');
  const stays = counted(report.groups, 'LEFT_BEHIND');
  const list = (xs: string[]) => (
    <ul className="space-y-0.5">{xs.map((x) => <li key={x} className="break-words">{x}</li>)}</ul>
  );
  const countList = (xs: Array<[string, number]>) => (
    <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
      {xs.map(([entity, n]) => (
        <li key={entity}>{entity} <span className="text-text-muted tabular-nums">{n}</span></li>
      ))}
    </ul>
  );

  return (
    <dl className="inset-panel divide-y divide-border-default" data-testid="move-check-result">
      {moves.length > 0 && (
        <ResultRow label="Moves">{countList(moves)}</ResultRow>
      )}
      {deleted.length > 0 && <ResultRow label="Deleted" tone="warn">{list(deleted)}</ResultRow>}
      {reauth.length > 0 && <ResultRow label="Re-authorize" tone="warn">{list(reauth)}</ResultRow>}
      {breaks.length > 0 && <ResultRow label="Breaks" tone="error">{list(breaks)}</ResultRow>}
      {stays.length > 0 && (
        <ResultRow label={`Stays in ${report.sourceTeamName}`}>{countList(stays)}</ResultRow>
      )}
    </dl>
  );
}

function OutcomeList({ outcomes, failed }: { outcomes: Outcome[]; failed?: boolean }) {
  if (!outcomes.length) return null;
  return (
    <ul className="space-y-1 text-[13px]">
      {outcomes.map((o, i) => {
        const ok = isPhaseSuccess(o.status);
        const detail = formatOutcomeDetail(o.detail);
        return (
          <li key={`${o.phase}-${i}`} className="flex items-baseline gap-2">
            <span className={ok ? 'text-status-success' : failed ? 'text-status-error' : 'text-text-muted'}>
              {ok ? '✓' : failed ? '✕' : '•'}
            </span>
            <span className="text-text-secondary">{formatPhaseLabel(o.phase)}</span>
            {detail && <span className="text-text-muted text-xs">{detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Move a workspace to another team, in one dialog: pick the team, "Check what
 * moves" runs POST /migrate/precheck and lists the result inline, and "Move
 * workspace" (POST /migrate/execute) is enabled only by a clean check for the
 * team currently picked. Picking another team discards the check.
 *
 * Moving sends every required item as confirmed: the check result above the
 * button is the confirmation.
 */
export default function MoveToTeamDialog({
  workspace,
  teams,
  onClose,
}: {
  workspace: MoveWorkspace;
  teams: MoveTeam[];
  onClose: () => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const destinations = useMemo(() => teams.filter((t) => t.id !== workspace.teamId), [teams, workspace.teamId]);
  const [teamId, setTeamId] = useState(destinations[0]?.id ?? '');
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState<'check' | 'move' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const current = check && check.teamId === teamId ? check : null;
  const blocked = current?.report.precheck.status === 'FAIL';
  const repairPending = !!result && !result.ok && !!result.repairRunId;
  const canMove = !!current && !blocked && busy === null && !repairPending;
  const teamName = teams.find((t) => t.id === teamId)?.name ?? '';

  function pickTeam(next: string) {
    setTeamId(next);
    setCheck(null);
    setError(null);
  }

  async function runCheck() {
    setBusy('check');
    setError(null);
    setCheck(null);
    setResult(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/migrate/precheck`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationTeamId: teamId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.report) {
        setError(data.error || 'Check failed');
        return;
      }
      setCheck({ teamId, report: data.report as DryRunReport, token: data.dryRunToken as string });
    } catch {
      setError('Check failed');
    } finally {
      setBusy(null);
    }
  }

  async function post(path: 'execute' | 'repair', body: unknown) {
    const res = await fetch(`/api/workspaces/${workspace.id}/migrate/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function runMove() {
    if (!current) return;
    setBusy('move');
    setError(null);
    try {
      const { res, data } = await post('execute', {
        destinationTeamId: current.teamId,
        dryRunToken: current.token,
        confirmedItems: current.report.requiredAcks,
      });
      if (res.ok) {
        setResult({ ok: true, outcomes: data.outcomes ?? [] });
        router.refresh();
      } else if (res.status === 500 && data.error === 'migration_failed') {
        setResult({ ok: false, outcomes: data.outcomes ?? [], repairRunId: data.runId ?? null });
        if (!data.runId) setCheck(null);
        setError(`Move failed${data.phase ? ` at ${formatPhaseLabel(data.phase)}` : ''}${data.message ? `: ${data.message}` : ''}`);
      } else if (data.error === 'invalid_token' || data.error === 'precheck_failed') {
        setCheck(null);
        setError(data.error === 'invalid_token' ? 'Check expired. Check again.' : 'Check no longer passes. Check again.');
      } else if (data.error === 'unconfirmed_items') {
        setCheck(null);
        setError('Check out of date. Check again.');
      } else {
        setError(data.error || 'Move failed');
      }
    } catch {
      setError('Move failed');
    } finally {
      setBusy(null);
    }
  }

  async function runRepair() {
    if (!result || result.ok || !result.repairRunId) return;
    setBusy('move');
    setError(null);
    try {
      const { res, data } = await post('repair', { runId: result.repairRunId });
      if (res.ok) {
        setResult({ ok: true, outcomes: data.outcomes ?? [] });
        router.refresh();
      } else {
        setError(data.error || 'Repair failed');
      }
    } catch {
      setError('Repair failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} dismissible={busy === null} className={PANEL}>
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-[15px] font-semibold text-text-primary min-w-0 break-words">
            Move {workspace.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {result?.ok ? (
          <>
            <p className="text-[13px] text-status-success" role="status">Moved to {teamName}.</p>
            <OutcomeList outcomes={result.outcomes} />
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn btn-lg">Close</button>
            </div>
          </>
        ) : (
          <>
            <div>
              <label htmlFor={`${titleId}-team`} className="field-label">Destination team</label>
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  id={`${titleId}-team`}
                  value={teamId}
                  onChange={(e) => pickTeam(e.target.value)}
                  disabled={busy !== null || repairPending}
                  className="w-full sm:flex-1 min-w-0 h-11 px-3 rounded-lg border bg-surface"
                >
                  {destinations.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={runCheck}
                  disabled={busy !== null || !teamId || repairPending}
                  className="btn btn-lg h-11 shrink-0"
                >
                  {busy === 'check' ? 'Checking…' : current ? 'Check again' : 'Check what moves'}
                </button>
              </div>
            </div>

            {blocked && (
              <p className="text-[13px] text-status-error" role="alert">
                {current!.report.precheck.githubApp.message || 'Blocked by the precheck.'}
              </p>
            )}
            {error && <p className="text-[13px] text-status-error" role="alert">{error}</p>}

            {current && !blocked && !repairPending && <CheckResult report={current.report} />}
            {result && !result.ok && <OutcomeList outcomes={result.outcomes} failed />}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={busy !== null} className="btn btn-lg btn-quiet">
                Cancel
              </button>
              {repairPending ? (
                <button type="button" onClick={runRepair} disabled={busy !== null} className="btn btn-lg btn-primary">
                  {busy === 'move' ? 'Repairing…' : 'Repair'}
                </button>
              ) : (
                <button type="button" onClick={runMove} disabled={!canMove} className="btn btn-lg btn-primary">
                  {busy === 'move' ? 'Moving…' : 'Move workspace'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** "Move to team…" button that owns the dialog. */
export function MoveToTeamButton({
  workspace,
  teams,
  className = 'btn min-h-11',
}: {
  workspace: MoveWorkspace;
  teams: MoveTeam[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} aria-haspopup="dialog">
        Move to team&hellip;
      </button>
      {open && <MoveToTeamDialog workspace={workspace} teams={teams} onClose={() => setOpen(false)} />}
    </>
  );
}
