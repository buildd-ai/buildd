'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EscalationAction, EscalationActionId, EscalationBrief } from '@buildd/workflow-kernel/escalation-brief';
import Sheet from '@/components/ui/Sheet';
import FindingDisposeForm from './FindingDisposeForm';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { countWord } from '@buildd/shared';
import { DECISION_LABELS, parseDecisionHash, type DecisionCopy } from '@/lib/workflow/escalation-copy';

const ENDPOINT: Partial<Record<EscalationActionId, string>> = {
  request_fix: 'apply-recommendation',
  force_re_review: 're-review',
  land_pr: 'land',
  approve_override: 'approve-override',
};

const DONE: Partial<Record<EscalationActionId, string>> = {
  request_fix: 'One more fix was requested. The automatic budget is still spent.',
  force_re_review: 'A forced re-review was requested for the current head.',
  land_pr: 'One task was filed on the PR branch. The head it pushes gets one review.',
  approve_override: 'Head approved over remaining findings. Merge follows the workspace policy.',
};

/**
 * The task page's decision surface for a review escalation (#task-decision), spec r7
 * §7 AC-43 / AC-48: each unresolved finding by name, and only the actions this person
 * may take. The verdict row above it carries the question and why automation stopped. Choosing one opens a sheet that
 * says what it does before anything runs; nothing here runs on its own. Each confirm
 * calls the existing human-triggered route, which re-checks access, and the page
 * refreshes so the verdict row reconciles.
 *
 * The verdict row's button links to `#task-decision-<action>`, which scrolls here and
 * opens that action's sheet, so a phone reaches the decision without GitHub.
 */
export default function EscalationDecision({ brief, copy, prNumber, workspaceId, findingsBelow = false }: {
  brief: EscalationBrief; copy: DecisionCopy; prNumber: number; workspaceId: string;
  /**
   * The open Code review row right below lists every open finding (Task Page AC-28): the card does not
   * name them again (Living Spec fa62b865 R-48). Elsewhere (the mission page) the card names them.
   */
  findingsBelow?: boolean;
}) {
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<EscalationAction | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [showFindings, setShowFindings] = useState(false);
  // Approve and override takes an optional reason in its confirmation sheet.
  const [overrideReason, setOverrideReason] = useState('');

  function choose(a: EscalationAction) {
    if (a.id === 'review_findings') { setShowFindings((v) => !v); return; }
    setNote(null);
    if (a.id === 'approve_override') setOverrideReason('');
    setConfirming(a);
  }

  useEffect(() => {
    const open = () => {
      const id = parseDecisionHash(window.location.hash);
      const a = id ? copy.actions.find((x) => x.id === id) : undefined;
      if (!a) return;
      ref.current?.scrollIntoView({ block: 'start' });
      if (a.id === 'review_findings') setShowFindings(true);
      else { setNote(null); setConfirming(a); }
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, [copy.actions]);

  async function confirmAction(a: EscalationAction) {
    const path = ENDPOINT[a.id];
    if (!path) return;
    setBusy(true);
    const head = brief.decisionHead.headSha ? { headSha: brief.decisionHead.headSha, version: brief.decisionHead.version } : {};
    const extra = a.id === 'approve_override' && overrideReason.trim() ? { reason: overrideReason.trim() } : {};
    try {
      // AC-45: the decision is bound to the head and delivery version this card showed; a stale one comes back 409 with a plain sentence.
      const res = await fetch(`/api/prs/${prNumber}/${path}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...head, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setNote({ tone: 'err', text: data.error || `Could not ${a.label.toLowerCase()}. Try again.` });
      else { setNote({ tone: 'ok', text: DONE[a.id] ?? 'Done.' }); setOverrideReason(''); router.refresh(); }
    } catch {
      setNote({ tone: 'err', text: `Could not ${a.label.toLowerCase()}. Try again.` });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  const named: Array<[string, string[]]> = [
    [DECISION_LABELS.open, copy.unresolved.open],
    [DECISION_LABELS.awaitingVerification, copy.unresolved.awaitingVerification],
  ];
  const remaining = brief.totals.open + brief.totals.addressedAwaitingVerification;
  // #5154: a finding can be waived or deferred while it is open or awaiting verification.
  const groups: Array<{ label: string; list: typeof brief.findings.open; disposable: boolean }> = [
    { label: DECISION_LABELS.open, list: brief.findings.open, disposable: true },
    { label: DECISION_LABELS.awaitingVerification, list: brief.findings.addressedAwaitingVerification, disposable: true },
    { label: 'Resolved', list: brief.findings.resolved, disposable: false },
    { label: 'Waived', list: brief.findings.waived ?? [], disposable: false },
    { label: 'Deferred', list: brief.findings.deferred ?? [], disposable: false },
  ];

  return (
    <section ref={ref} id="task-decision" data-testid="task-decision" data-cause={brief.cause} aria-label={copy.question} className="card-decision mb-6 scroll-mt-4 px-4 py-3 md:px-5">
      {/* The verdict row right above carries the question and why it stopped; the card names what is left and the choices (say it once). */}
      {!findingsBelow && named.filter(([, list]) => list.length > 0).map(([label, list], i) => (
        <div key={label} data-testid="decision-unresolved" className={i === 0 ? '' : 'mt-3'}>
          <h3 className="text-meta font-medium text-text-muted">{label}</h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {list.map((t, i) => <li key={`${label}-${i}`} className="text-body [overflow-wrap:anywhere]">{t}</li>)}
          </ul>
        </div>
      ))}
      {showFindings && (
        <div data-testid="decision-findings" className="mt-3 flex flex-col gap-3 border-t border-border-default pt-3">
          {groups.filter((g) => g.list.length > 0).map(({ label, list, disposable }) => (
            <div key={label}>
              <h3 className="text-meta font-medium text-text-muted">{label}</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {list.map((f) => (
                  <li key={f.id} className="text-body [overflow-wrap:anywhere]">
                    {f.title}
                    {f.path && <span className="font-mono text-meta text-text-muted"> {f.path}{f.line != null ? `:${f.line}` : ''}</span>}
                    {f.stale && <span className="text-meta text-text-muted"> · touched by an older push</span>}
                    {disposable && <FindingDisposeForm prNumber={prNumber} workspaceId={workspaceId} findingId={f.id} decisionHead={brief.decisionHead} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2 md:flex-row md:flex-wrap">
        {copy.actions.map((a) => a.id === copy.primary.id ? (
          <PrimaryAction key={a.id} data-testid={`decision-action-${a.id}`} fullWidthOnMobile disabled={busy} onClick={() => choose(a)}>{a.label}</PrimaryAction>
        ) : (
          <button
            key={a.id}
            type="button"
            data-testid={`decision-action-${a.id}`}
            disabled={busy}
            onClick={() => choose(a)}
            aria-expanded={a.id === 'review_findings' ? showFindings : undefined}
            className="inline-flex min-h-11 w-full items-center justify-center border-2 border-border-strong px-4 text-body font-medium text-text-primary hover:bg-surface-3 disabled:opacity-50 md:w-auto"
          >
            {a.label}
          </button>
        ))}
      </div>
      {note && <p role="status" data-testid="decision-note" className={`mt-3 text-body ${note.tone === 'err' ? 'text-status-error' : 'text-text-primary'}`}>{note.text}</p>}
      <Sheet open={confirming != null} onClose={() => { if (!busy) setConfirming(null); }} title={confirming?.label ?? ''} testId="decision-sheet">
        {confirming && (
          <div className="flex flex-col gap-3 px-4 pb-4">
            <p data-testid="decision-sheet-impact" className="text-body text-text-primary">{confirming.impact}</p>
            <p className="text-meta text-text-muted">Who can do this: {confirming.requires}.</p>
            {confirming.id === 'approve_override' && (
              <label data-testid="decision-override-reason" className="flex flex-col gap-1 text-meta text-text-secondary">Reason (optional)
                <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} maxLength={500} className="border border-border-default bg-surface-1 px-2 py-1 text-body text-text-primary" />
              </label>
            )}
            <div className="flex flex-col gap-2 md:flex-row">
              <PrimaryAction data-testid="decision-sheet-confirm" fullWidthOnMobile pending={busy} onClick={() => confirmAction(confirming)}>{confirming.id === 'approve_override' ? `Approve over ${countWord(remaining)} ${remaining === 1 ? 'finding' : 'findings'}` : confirming.label}</PrimaryAction>
              <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="inline-flex min-h-11 w-full items-center justify-center border-2 border-border-strong px-4 text-body font-medium text-text-primary hover:bg-surface-3 md:w-auto">Cancel</button>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
}
