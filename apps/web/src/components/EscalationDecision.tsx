'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EscalationAction, EscalationActionId, EscalationBrief } from '@buildd/workflow-kernel/escalation-brief';
import Sheet from '@/components/ui/Sheet';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { parseDecisionHash, type DecisionCopy } from './escalation-decision-copy';

const ENDPOINT: Partial<Record<EscalationActionId, string>> = {
  request_fix: 'apply-recommendation',
  force_re_review: 're-review',
};

const DONE: Partial<Record<EscalationActionId, string>> = {
  request_fix: 'One more fix was requested. The automatic budget is still spent.',
  force_re_review: 'A forced re-review was requested for the current head.',
};

/**
 * The task page's decision surface for a review escalation (#task-decision), spec r7
 * §7 AC-43 / AC-48: the question, why automation stopped, each unresolved finding by
 * name, and only the actions this person may take. Choosing one opens a sheet that
 * says what it does before anything runs; nothing here runs on its own. Each confirm
 * calls the existing human-triggered route, which re-checks access, and the page
 * refreshes so the verdict row reconciles.
 *
 * The verdict row's button links to `#task-decision-<action>`, which scrolls here and
 * opens that action's sheet, so a phone reaches the decision without GitHub.
 */
export default function EscalationDecision({ brief, copy, prNumber, workspaceId }: { brief: EscalationBrief; copy: DecisionCopy; prNumber: number; workspaceId: string }) {
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<EscalationAction | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [showFindings, setShowFindings] = useState(false);

  function choose(a: EscalationAction) {
    if (a.id === 'review_findings') { setShowFindings((v) => !v); return; }
    setNote(null);
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

  async function confirm(a: EscalationAction) {
    const path = ENDPOINT[a.id];
    if (!path) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/prs/${prNumber}/${path}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setNote({ tone: 'err', text: data.error || `Could not ${a.label.toLowerCase()}. Try again.` });
      else { setNote({ tone: 'ok', text: DONE[a.id] ?? 'Done.' }); router.refresh(); }
    } catch {
      setNote({ tone: 'err', text: `Could not ${a.label.toLowerCase()}. Try again.` });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  const named: Array<[string, string[]]> = [
    ['Still open', copy.unresolved.open],
    ['Fixed, waiting for a review', copy.unresolved.awaitingVerification],
  ];
  const groups: Array<[string, typeof brief.findings.open]> = [
    ['Still open', brief.findings.open],
    ['Fixed, waiting for a review', brief.findings.addressedAwaitingVerification],
    ['Resolved', brief.findings.resolved],
  ];

  return (
    <section ref={ref} id="task-decision" data-testid="task-decision" data-cause={brief.cause} aria-label="Decision" className="card-decision mb-6 scroll-mt-4 px-4 py-3 md:px-5">
      <h2 data-testid="decision-question" className="text-body font-semibold">{copy.question}</h2>
      <p data-testid="decision-why" className="mt-1 text-body text-text-secondary">{copy.why}</p>
      {named.filter(([, list]) => list.length > 0).map(([label, list]) => (
        <div key={label} data-testid="decision-unresolved" className="mt-3">
          <h3 className="text-meta font-medium text-text-muted">{label}</h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {list.map((t, i) => <li key={`${label}-${i}`} className="text-body [overflow-wrap:anywhere]">{t}</li>)}
          </ul>
        </div>
      ))}
      {showFindings && (
        <div data-testid="decision-findings" className="mt-3 flex flex-col gap-3 border-t border-border-default pt-3">
          {groups.filter(([, list]) => list.length > 0).map(([label, list]) => (
            <div key={label}>
              <h3 className="text-meta font-medium text-text-muted">{label}</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {list.map((f) => (
                  <li key={f.id} className="text-body [overflow-wrap:anywhere]">
                    {f.title}
                    {f.path && <span className="font-mono text-meta text-text-muted"> {f.path}{f.line != null ? `:${f.line}` : ''}</span>}
                    {f.stale && <span className="text-meta text-text-muted"> · touched by an older push</span>}
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
            <div className="flex flex-col gap-2 md:flex-row">
              <PrimaryAction data-testid="decision-sheet-confirm" fullWidthOnMobile pending={busy} onClick={() => confirm(confirming)}>{confirming.label}</PrimaryAction>
              <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="inline-flex min-h-11 w-full items-center justify-center border-2 border-border-strong px-4 text-body font-medium text-text-primary hover:bg-surface-3 md:w-auto">Cancel</button>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
}
