'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

// Redeclared locally — do NOT import from @/lib/workspace-migration (server-only db code).
type EntityDisposition =
  | 'MOVES_CLEANLY'
  | 'NEEDS_RE_ENTRY'
  | 'NEEDS_RE_AUTH'
  | 'WILL_BREAK'
  | 'LEFT_BEHIND';

interface DryRunItem {
  key: string;
  label: string;
  disposition: EntityDisposition;
}

interface DryRunGroup {
  entity: string;
  disposition: EntityDisposition;
  count: number;
  detail?: string;
  items?: DryRunItem[];
}

interface DryRunReport {
  workspaceId: string;
  workspaceName: string;
  sourceTeamId: string;
  sourceTeamName: string;
  destinationTeamId: string;
  destinationTeamName: string;
  generatedAt: string;
  precheck: { status: 'PASS' | 'FAIL'; githubApp: { org: string | null; ok: boolean; message?: string } };
  summary: Record<EntityDisposition, number>;
  groups: DryRunGroup[];
  requiredAcks: string[];
}

interface ExecuteOutcome {
  phase: string;
  status: string;
  detail?: string;
}

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Team {
  id: string;
  name: string;
}

type Step = 'pick' | 'report' | 'confirm' | 'running' | 'done';

const DEFAULT_EXPANDED: EntityDisposition[] = ['NEEDS_RE_ENTRY', 'NEEDS_RE_AUTH', 'WILL_BREAK'];

const DISPOSITION_LABELS: Record<EntityDisposition, string> = {
  MOVES_CLEANLY: 'Moves cleanly',
  NEEDS_RE_ENTRY: 'Needs re-entry',
  NEEDS_RE_AUTH: 'Needs re-auth',
  WILL_BREAK: 'Will break',
  LEFT_BEHIND: 'Left behind',
};

function dispositionBadgeClass(d: EntityDisposition): string {
  switch (d) {
    case 'WILL_BREAK':
      return 'bg-status-error/10 text-status-error border border-status-error/30';
    case 'NEEDS_RE_ENTRY':
    case 'NEEDS_RE_AUTH':
      return 'bg-status-warning/10 text-status-warning border border-status-warning/30';
    case 'MOVES_CLEANLY':
      return 'bg-status-success/10 text-status-success border border-status-success/30';
    case 'LEFT_BEHIND':
    default:
      return 'bg-surface-3 text-text-muted border border-border-default';
  }
}

export default function WorkspaceMigrationModal({
  workspace,
  teams,
  onClose,
}: {
  workspace: Workspace;
  teams: Team[];
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('pick');
  const destinationOptions = useMemo(
    () => teams.filter((t) => t.id !== workspace.teamId),
    [teams, workspace.teamId],
  );
  const [destinationTeamId, setDestinationTeamId] = useState<string>(destinationOptions[0]?.id ?? '');
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [dryRunToken, setDryRunToken] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checkedAcks, setCheckedAcks] = useState<Set<string>>(new Set());
  const [leftBehindAck, setLeftBehindAck] = useState(false);

  const [outcomes, setOutcomes] = useState<ExecuteOutcome[]>([]);
  const [repairRunId, setRepairRunId] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !loading && step !== 'running') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [loading, step, onClose]);

  const destinationTeamName =
    report?.destinationTeamName ?? teams.find((t) => t.id === destinationTeamId)?.name ?? 'the destination team';

  const leftBehindCount = report?.summary?.LEFT_BEHIND ?? 0;

  // Human labels for required-ack keys, resolved from group items.
  const ackLabels = useMemo(() => {
    const map = new Map<string, string>();
    if (report) {
      for (const g of report.groups) {
        for (const item of g.items ?? []) map.set(item.key, item.label);
      }
    }
    return map;
  }, [report]);

  const allAcksChecked =
    !!report &&
    report.requiredAcks.every((k) => checkedAcks.has(k)) &&
    (leftBehindCount === 0 || leftBehindAck);

  async function runDryRun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/migrate/precheck`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationTeamId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to run dry run');
        return;
      }
      setReport(data.report as DryRunReport);
      setDryRunToken(data.dryRunToken as string);
      // Expand groups that need attention by default.
      const next = new Set<string>();
      for (const g of (data.report as DryRunReport).groups) {
        if (DEFAULT_EXPANDED.includes(g.disposition)) next.add(g.entity);
      }
      setExpanded(next);
      setStep('report');
    } catch {
      setError('Failed to run dry run');
    } finally {
      setLoading(false);
    }
  }

  function toggleGroup(entity: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) next.delete(entity);
      else next.add(entity);
      return next;
    });
  }

  async function runExecute() {
    if (!report) return;
    setLoading(true);
    setError(null);
    setRepairRunId(null);
    setStep('running');
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/migrate/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          destinationTeamId,
          dryRunToken,
          confirmedItems: report.requiredAcks,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setOutcomes(data.outcomes ?? []);
        setSucceeded(true);
        setStep('done');
        return;
      }
      // Error handling by status + error code.
      if (res.status === 400 && data.error === 'invalid_token') {
        setError('This dry run has expired. Please re-run the dry run before migrating.');
        setStep('confirm');
      } else if (res.status === 400 && data.error === 'unconfirmed_items') {
        const missing = Array.isArray(data.missing) ? data.missing.join(', ') : '';
        setError(`Some required items are not confirmed${missing ? `: ${missing}` : ''}.`);
        setStep('confirm');
      } else if (res.status === 409 && data.error === 'precheck_failed') {
        setError('The precheck no longer passes. Please re-run the dry run.');
        setStep('confirm');
      } else if (res.status === 403) {
        setError(data.error || 'You do not have permission to migrate this workspace.');
        setStep('confirm');
      } else if (res.status === 500 && data.error === 'migration_failed') {
        setOutcomes(data.outcomes ?? []);
        setRepairRunId(data.runId ?? null);
        setError(
          `Migration failed${data.phase ? ` during "${data.phase}"` : ''}${data.message ? `: ${data.message}` : ''}.`,
        );
        setSucceeded(false);
        setStep('done');
      } else {
        setError(data.error || 'Migration failed');
        setStep('confirm');
      }
    } catch {
      setError('Migration failed');
      setStep('confirm');
    } finally {
      setLoading(false);
    }
  }

  async function runRepair() {
    if (!repairRunId) return;
    setLoading(true);
    setError(null);
    setStep('running');
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/migrate/repair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: repairRunId }),
      });
      const data = await res.json();
      if (res.ok) {
        setOutcomes(data.outcomes ?? []);
        setRepairRunId(null);
        setSucceeded(true);
        setStep('done');
      } else {
        setError(data.error || 'Repair failed');
        setStep('done');
      }
    } catch {
      setError('Repair failed');
      setStep('done');
    } finally {
      setLoading(false);
    }
  }

  const precheckFailed = report?.precheck.status === 'FAIL';

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && !loading && step !== 'running' && onClose()}
    >
      <div className="bg-surface-2 rounded-lg shadow-xl w-full max-w-[calc(100vw-2rem)] sm:max-w-lg mx-4">
        <div className="p-6 overflow-y-auto max-h-[75vh]">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Migrate “{workspace.name}”</h3>
              {step !== 'done' && (
                <p className="mt-1 text-sm text-text-secondary">
                  Move this workspace to another team.
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              disabled={loading || step === 'running'}
              className="text-text-muted hover:text-text-primary disabled:opacity-50"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg text-sm bg-status-error/10 text-status-error border border-status-error/30">
              {error}
            </div>
          )}

          {/* STEP: pick */}
          {step === 'pick' && (
            <div className="space-y-4">
              <label className="block">
                <span className="block text-xs font-medium text-text-secondary mb-1">Destination team</span>
                <select
                  value={destinationTeamId}
                  onChange={(e) => setDestinationTeamId(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border bg-surface"
                >
                  {destinationOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-4 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={runDryRun}
                  disabled={loading || !destinationTeamId}
                  className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {loading ? 'Running…' : 'Run dry run'}
                </button>
              </div>
            </div>
          )}

          {/* STEP: report */}
          {step === 'report' && report && (
            <div className="space-y-4">
              <div className="text-sm text-text-secondary">
                {report.sourceTeamName} → {report.destinationTeamName}
              </div>

              {precheckFailed && (
                <div className="p-3 rounded-lg text-sm bg-status-error/10 text-status-error border border-status-error/30">
                  {report.precheck.githubApp.message || 'Precheck failed. Migration cannot proceed.'}
                </div>
              )}

              <div className="space-y-2">
                {report.groups.map((g) => {
                  const isOpen = expanded.has(g.entity);
                  return (
                    <div key={g.entity} className="card p-0">
                      <button
                        onClick={() => toggleGroup(g.entity)}
                        className="w-full flex items-center justify-between gap-3 p-3 text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-text-muted text-xs">{isOpen ? '▾' : '▸'}</span>
                          <span className="text-sm font-medium text-text-primary truncate">{g.entity}</span>
                          <span className="text-xs text-text-muted">({g.count})</span>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded font-mono whitespace-nowrap ${dispositionBadgeClass(g.disposition)}`}>
                          {DISPOSITION_LABELS[g.disposition]}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="px-3 pb-3 border-t border-border-default pt-2 space-y-1">
                          {g.detail && <div className="text-xs text-text-muted mb-1">{g.detail}</div>}
                          {(g.items ?? []).map((item) => (
                            <div key={item.key} className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-text-secondary truncate">{item.label}</span>
                              <span className={`px-1.5 py-0.5 rounded font-mono whitespace-nowrap ${dispositionBadgeClass(item.disposition)}`}>
                                {DISPOSITION_LABELS[item.disposition]}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setStep('pick')}
                  className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-4 rounded-lg"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep('confirm')}
                  disabled={precheckFailed}
                  className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* STEP: confirm */}
          {step === 'confirm' && report && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                Confirm each item below before migrating. These actions cannot be automatically undone.
              </p>

              {report.requiredAcks.length > 0 && (
                <div className="space-y-2">
                  {report.requiredAcks.map((key) => (
                    <label key={key} className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checkedAcks.has(key)}
                        onChange={(e) => {
                          setCheckedAcks((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                      <span className="text-text-primary">{ackLabels.get(key) ?? key}</span>
                    </label>
                  ))}
                </div>
              )}

              {leftBehindCount > 0 && (
                <label className="flex items-start gap-2 text-sm cursor-pointer border-t border-border-default pt-3">
                  <input
                    type="checkbox"
                    checked={leftBehindAck}
                    onChange={(e) => setLeftBehindAck(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-text-primary">
                    I understand {leftBehindCount} item{leftBehindCount === 1 ? '' : 's'} stay
                    {leftBehindCount === 1 ? 's' : ''} with the source team.
                  </span>
                </label>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setStep('report')}
                  className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-4 rounded-lg"
                >
                  Back
                </button>
                <button
                  onClick={runExecute}
                  disabled={loading || !allAcksChecked}
                  className="px-4 py-2 text-sm rounded-lg bg-status-error text-white hover:opacity-90 disabled:opacity-50"
                >
                  Migrate
                </button>
              </div>
            </div>
          )}

          {/* STEP: running */}
          {step === 'running' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm text-text-secondary">
                <span className="inline-block w-4 h-4 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
                Migrating workspace…
              </div>
              {outcomes.length > 0 && (
                <ul className="space-y-1">
                  {outcomes.map((o, i) => (
                    <li key={`${o.phase}-${i}`} className="flex items-center gap-2 text-sm">
                      <span className={o.status === 'ok' ? 'text-status-success' : 'text-text-muted'}>
                        {o.status === 'ok' ? '✓' : '•'}
                      </span>
                      <span className="text-text-secondary">{o.phase}</span>
                      {o.detail && <span className="text-text-muted text-xs">— {o.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* STEP: done */}
          {step === 'done' && (
            <div className="space-y-4">
              {succeeded ? (
                <>
                  <div className="p-3 rounded-lg text-sm bg-status-success/10 text-status-success border border-status-success/30">
                    Migration complete. {workspace.name} now belongs to {destinationTeamName}.
                  </div>
                  {outcomes.length > 0 && (
                    <ul className="space-y-1">
                      {outcomes.map((o, i) => (
                        <li key={`${o.phase}-${i}`} className="flex items-center gap-2 text-sm">
                          <span className={o.status === 'ok' ? 'text-status-success' : 'text-text-muted'}>
                            {o.status === 'ok' ? '✓' : '•'}
                          </span>
                          <span className="text-text-secondary">{o.phase}</span>
                          {o.detail && <span className="text-text-muted text-xs">— {o.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/app/workspaces/${workspace.id}`}
                      className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover"
                    >
                      Go to workspace settings
                    </Link>
                    <button
                      onClick={onClose}
                      className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-4 rounded-lg"
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {outcomes.length > 0 && (
                    <ul className="space-y-1">
                      {outcomes.map((o, i) => (
                        <li key={`${o.phase}-${i}`} className="flex items-center gap-2 text-sm">
                          <span className={o.status === 'ok' ? 'text-status-success' : 'text-status-error'}>
                            {o.status === 'ok' ? '✓' : '✕'}
                          </span>
                          <span className="text-text-secondary">{o.phase}</span>
                          {o.detail && <span className="text-text-muted text-xs">— {o.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex justify-end gap-2">
                    {repairRunId ? (
                      <button
                        onClick={runRepair}
                        disabled={loading}
                        className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
                      >
                        {loading ? 'Repairing…' : 'Repair'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setStep('confirm')}
                        className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary-hover"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={onClose}
                      className="px-4 py-2 text-sm text-text-secondary hover:bg-surface-4 rounded-lg"
                    >
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
