'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { GoalCriterion } from '@buildd/shared';
import { SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH } from '@buildd/core/surface-audit';
import { AddCriterionForm } from './MissionGoalCriteria';

export interface SurfaceAuditDecision {
  /** The UI files the mission changed (the completion gate's read), for the collapsed list. */
  paths: string[];
  /** `executor: local`: shared runners will not claim the audit task. */
  executorLocal: boolean;
}

interface Props {
  missionId: string;
  /** Every stored criterion — needed so "fix" can splice the edited one back in. */
  goalCriteria: GoalCriterion[];
  /** Index (into `goalCriteria`) of the first non-passing criterion, if any. */
  failingCriterionIndex: number | null;
  fileWorkHref: string;
  /** The mission states criteria and they have not all passed. The criteria exits render only then. */
  criteriaUnmet: boolean;
  /** Set when the completion blocker is a missing visual audit. */
  surfaceAudit?: SurfaceAuditDecision | null;
}

type Recommendation = 'audit' | 'waive';
interface Advice { recommend: Recommendation; why: string; waiverDraft?: string }

/** How long the sheet waits for a suggestion before showing both actions bare. */
const ADVICE_TIMEOUT_MS = 8_000;

const BUTTON = 'text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border-default rounded-md px-2.5 py-1 text-left max-w-full disabled:opacity-50';
const BUTTON_SUGGESTED = 'text-[12px] font-medium text-text-primary border border-status-warning/60 bg-status-warning/10 rounded-md px-2.5 py-1 text-left max-w-full disabled:opacity-50';
const SUBTITLE = 'mt-0.5 text-[11px] leading-snug text-text-muted [overflow-wrap:anywhere]';

function parseAdvice(value: unknown): Advice | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if ((v.recommend !== 'audit' && v.recommend !== 'waive') || typeof v.why !== 'string' || !v.why.trim()) return null;
  return {
    recommend: v.recommend,
    why: v.why,
    ...(typeof v.waiverDraft === 'string' && v.waiverDraft.trim() ? { waiverDraft: v.waiverDraft } : {}),
  };
}

function Action({ children, subtitle, suggested }: { children: ReactNode; subtitle: string; suggested?: boolean }) {
  return (
    <div className="min-w-0 max-w-full" data-recommended={suggested ? 'true' : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {suggested && <span className="text-[11px] font-semibold uppercase tracking-wide text-status-warning">Suggested</span>}
      </div>
      <p className={SUBTITLE}>{subtitle}</p>
    </div>
  );
}

/**
 * The exits for a mission waiting on a person, attached to the mission-detail
 * "needs your decision" banner. Which exits render follows what actually blocks
 * completion, so no button leads to a refusal:
 *
 * - **Missing visual audit** (`surfaceAudit`): run the audit, or waive it with a
 *   written reason. A decision model may suggest one (pre-selected, reason
 *   prefilled); the person always confirms, and no suggestion means both
 *   actions stand bare.
 * - **Unmet goal criteria** (`criteriaUnmet`): file the work, fix the
 *   criterion, or waive and complete.
 *
 * Neither ⇒ nothing renders. The criteria heuristic
 * (`inferCriteriaFailureReading`) is shown as a recommendation elsewhere and
 * never used here to pick a default: a wrong default would file a phantom task
 * or waive a mission nobody meant to waive.
 */
export default function MissionDecisionSheet({
  missionId,
  goalCriteria,
  failingCriterionIndex,
  fileWorkHref,
  criteriaUnmet,
  surfaceAudit = null,
}: Props) {
  const router = useRouter();

  // Criteria exits
  const [fixOpen, setFixOpen] = useState(false);
  const [fixSaving, setFixSaving] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [waiveError, setWaiveError] = useState<string | null>(null);

  // Visual audit exits
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const [reason, setReason] = useState('');
  const reasonTouched = useRef(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditRequested, setAuditRequested] = useState<{ created: boolean } | null>(null);
  const [auditWaiving, setAuditWaiving] = useState(false);
  const [auditWaived, setAuditWaived] = useState<{ reason: string; completed: boolean } | null>(null);

  const failingCriterion = criteriaUnmet && failingCriterionIndex != null ? goalCriteria[failingCriterionIndex] ?? null : null;
  const asksAboutAudit = !!surfaceAudit;

  useEffect(() => {
    if (!asksAboutAudit) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADVICE_TIMEOUT_MS);
    (async () => {
      try {
        const res = await fetch(`/api/missions/${missionId}/surface-audit/advice`, { method: 'POST', signal: controller.signal });
        if (!res.ok) return;
        const parsed = parseAdvice((await res.json().catch(() => null))?.advice);
        if (!parsed || controller.signal.aborted) return;
        setAdvice(parsed);
        // A person already choosing is never overridden by a late suggestion.
        setSelected(prev => prev ?? parsed.recommend);
        if (parsed.recommend === 'waive' && parsed.waiverDraft && !reasonTouched.current) setReason(parsed.waiverDraft);
      } catch {
        // Fail soft: both actions stand with nothing pre-selected.
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [asksAboutAudit, missionId]);

  async function handleFix(updated: GoalCriterion) {
    if (failingCriterionIndex == null) return;
    setFixSaving(true);
    setFixError(null);
    try {
      const next = goalCriteria.map((c, i) => (i === failingCriterionIndex ? updated : c));
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalCriteria: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFixError(body.error ?? `Could not save criterion (HTTP ${res.status})`);
        return;
      }
      // The owner should see the new verdict in this same interaction — the
      // mission's heartbeat is stood down and will not produce one on its own.
      await fetch(`/api/missions/${missionId}/evaluate`, { method: 'POST' }).catch(() => {});
      setFixOpen(false);
      router.refresh();
    } catch {
      setFixError('Could not reach buildd. Criterion not saved.');
    } finally {
      setFixSaving(false);
    }
  }

  async function handleWaiveConfirm() {
    setWaiving(true);
    setWaiveError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // The server's wording for a missing audit is written for an agent; a person gets the visual audit actions.
        setWaiveError(body.code === 'surface_audit_missing'
          ? 'The visual audit needs a decision first. Use the visual audit actions above.'
          : body.error ?? `Could not complete mission (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setWaiveError('Could not reach buildd. Mission not completed.');
    } finally {
      setWaiving(false);
    }
  }

  async function handleRunAudit() {
    setSelected('audit');
    setAuditBusy(true);
    setAuditError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}/surface-audit`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuditError(typeof body.error === 'string' ? body.error : `Could not add the visual audit (HTTP ${res.status})`);
        return;
      }
      setAuditRequested({ created: body.created !== false });
      router.refresh();
    } catch {
      setAuditError('Could not reach buildd. The visual audit was not added.');
    } finally {
      setAuditBusy(false);
    }
  }

  async function handleWaiveAudit() {
    const trimmed = reason.trim();
    if (trimmed.length < SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH) {
      setReasonError(`Say why in at least ${SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH} characters, so the record makes sense later.`);
      return;
    }
    setReasonError(null);
    setAuditWaiving(true);
    setAuditError(null);
    // With criteria also unmet, only the audit is waived: completing here would
    // silently waive the criteria too.
    const completes = !criteriaUnmet;
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completes ? { surfaceAuditWaiver: trimmed, status: 'completed' } : { surfaceAuditWaiver: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAuditError(typeof body.error === 'string' && body.code !== 'surface_audit_missing'
          ? body.error
          : `Could not save the waiver (HTTP ${res.status}). Nothing was recorded.`);
        return;
      }
      // Shown only now: a refused request records nothing, so the screen never claims it did.
      setAuditWaived({ reason: trimmed, completed: completes });
      router.refresh();
    } catch {
      setAuditError('Could not reach buildd. The waiver was not saved.');
    } finally {
      setAuditWaiving(false);
    }
  }

  if (!surfaceAudit && !criteriaUnmet) return null;

  const showLabels = !!surfaceAudit && criteriaUnmet;
  const suggestedAudit = advice?.recommend === 'audit';
  const suggestedWaive = advice?.recommend === 'waive';
  const auditDone = auditRequested !== null || auditWaived !== null;

  return (
    <div className="mt-2 min-w-0 max-w-full space-y-3" data-testid="mission-decision-sheet">
      {surfaceAudit && (
        <div className="min-w-0 space-y-2" data-testid="surface-audit-decision">
          {showLabels && (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Visual audit</p>
          )}

          {surfaceAudit.paths.length > 0 && (
            <details className="text-[11px] text-text-muted" data-testid="surface-audit-files">
              <summary className="cursor-pointer select-none">
                Show the {surfaceAudit.paths.length} changed UI {surfaceAudit.paths.length === 1 ? 'file' : 'files'}
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono [overflow-wrap:anywhere]">
                {surfaceAudit.paths.map(p => <li key={p} className="min-w-0 break-all">{p}</li>)}
              </ul>
            </details>
          )}

          {advice && !auditDone && (
            <p className="text-[12px] text-text-secondary [overflow-wrap:anywhere]" data-testid="surface-audit-advice">
              {advice.why}
            </p>
          )}

          {auditRequested && (
            <p role="status" className="text-[12px] text-text-secondary" data-testid="surface-audit-requested">
              {auditRequested.created
                ? 'A visual audit was added to this mission. It completes once the audit finishes.'
                : 'A visual audit is already on this mission.'}
            </p>
          )}

          {auditWaived && (
            <p role="status" className="text-[12px] text-text-secondary [overflow-wrap:anywhere]" data-testid="surface-audit-waived">
              {auditWaived.completed ? 'Visual audit waived and mission completed.' : 'Visual audit waived.'} Reason recorded: {auditWaived.reason}
            </p>
          )}

          {!auditDone && (
            <>
              <Action
                suggested={suggestedAudit}
                subtitle={surfaceAudit.executorLocal
                  ? 'Adds a check of the changed screens to this mission. It runs on your own machine, so buildd\'s runners will not pick it up.'
                  : 'Adds a check of the changed screens to this mission. It completes once the audit finishes.'}
              >
                <button
                  type="button"
                  onClick={handleRunAudit}
                  disabled={auditBusy || auditWaiving}
                  aria-pressed={selected === 'audit'}
                  className={suggestedAudit ? BUTTON_SUGGESTED : BUTTON}
                >
                  {auditBusy ? 'Adding…' : 'Run visual audit'}
                </button>
              </Action>

              <Action
                suggested={suggestedWaive}
                subtitle="Skips the audit and completes the mission. Your reason is saved to its record."
              >
                <button
                  type="button"
                  onClick={() => setSelected(prev => (prev === 'waive' ? null : 'waive'))}
                  disabled={auditBusy || auditWaiving}
                  aria-expanded={selected === 'waive'}
                  className={suggestedWaive ? BUTTON_SUGGESTED : BUTTON}
                >
                  Waive with reason
                </button>
              </Action>

              {selected === 'waive' && (
                <div className="border border-status-warning/30 bg-status-warning/5 rounded-sm p-3" data-testid="surface-audit-waive-panel">
                  <label htmlFor={`surface-audit-reason-${missionId}`} className="block text-[12px] text-text-secondary">
                    Why is no visual audit needed?
                  </label>
                  <textarea
                    id={`surface-audit-reason-${missionId}`}
                    value={reason}
                    onChange={e => { reasonTouched.current = true; setReason(e.target.value); if (reasonError) setReasonError(null); }}
                    rows={3}
                    required
                    aria-invalid={reasonError ? true : undefined}
                    className="mt-1 block w-full min-w-0 max-w-full text-[12px] text-text-primary bg-surface-1 border border-border-default rounded-sm px-2 py-1.5"
                    data-testid="surface-audit-reason"
                  />
                  {reasonError && <p role="alert" className="text-[11px] text-status-error mt-1">{reasonError}</p>}
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      disabled={auditWaiving}
                      className="text-[12px] font-medium text-text-muted hover:text-text-secondary border border-border-default rounded-md px-2.5 py-1 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleWaiveAudit}
                      disabled={auditWaiving}
                      className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 rounded-md px-2.5 py-1 disabled:opacity-50"
                    >
                      {auditWaiving ? 'Saving…' : criteriaUnmet ? 'Waive the audit' : 'Save reason and complete'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {auditError && <p role="alert" className="text-[11px] text-status-error [overflow-wrap:anywhere]">{auditError}</p>}
        </div>
      )}

      {criteriaUnmet && (
        <div className="min-w-0 space-y-2" data-testid="criteria-decision">
          {showLabels && (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Goal criteria</p>
          )}

          <Action subtitle="Create a task for what is missing, then come back to this decision.">
            <Link href={fileWorkHref} className={BUTTON}>
              File the work
            </Link>
          </Action>

          {failingCriterion && (
            <Action subtitle="Edit the criterion that is not passing, then re-check it now.">
              <button type="button" onClick={() => setFixOpen(v => !v)} className={BUTTON}>
                Fix the criterion
              </button>
            </Action>
          )}

          <Action subtitle="Completes the mission with its goal criteria unmet. The mission feed records the override.">
            <button type="button" onClick={() => setWaiveOpen(v => !v)} className={BUTTON}>
              Waive and complete
            </button>
          </Action>

          {fixOpen && failingCriterion && (
            <div className="mt-2">
              <AddCriterionForm
                initial={failingCriterion}
                submitLabel="Save & re-run"
                onAdd={handleFix}
                onCancel={() => setFixOpen(false)}
              />
              {fixSaving && <p className="text-[11px] text-text-muted mt-1">Saving…</p>}
              {fixError && <p role="alert" className="text-[11px] text-status-error mt-1">{fixError}</p>}
            </div>
          )}

          {waiveOpen && (
            <div className="mt-2 border border-status-warning/30 bg-status-warning/5 rounded-sm p-3">
              <p className="text-[12px] text-text-secondary">
                Marks the mission complete with its goal criteria unmet.
                The mission feed records the override.
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setWaiveOpen(false)}
                  disabled={waiving}
                  className="text-[12px] font-medium text-text-muted hover:text-text-secondary border border-border-default rounded-md px-2.5 py-1 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleWaiveConfirm}
                  disabled={waiving}
                  className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 rounded-md px-2.5 py-1 disabled:opacity-50"
                >
                  {waiving ? 'Completing…' : 'Mark complete'}
                </button>
              </div>
              {waiveError && <p role="alert" className="text-[11px] text-status-error mt-1.5 [overflow-wrap:anywhere]">{waiveError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
