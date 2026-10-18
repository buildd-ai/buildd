'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EscalationAction, EscalationActionId, EscalationBrief } from '@buildd/workflow-kernel/escalation-brief';

const ENDPOINT: Partial<Record<EscalationActionId, string>> = {
  request_fix: 'apply-recommendation',
  force_re_review: 're-review',
};

const DONE: Partial<Record<EscalationActionId, string>> = {
  request_fix: 'One more fix was requested. The automatic budget is still spent.',
  force_re_review: 'A forced re-review was requested for the current head.',
};

/**
 * The task page's decision surface for a review escalation (#task-decision): the cause,
 * what is left grouped by state, and each action a person may take with what it does.
 * Nothing here runs on its own; each button calls the existing human-triggered route,
 * which re-checks access, and the page refreshes so the verdict row reconciles.
 */
export default function EscalationDecision({ brief, prNumber, workspaceId }: { brief: EscalationBrief; prNumber: number; workspaceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<EscalationActionId | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [showFindings, setShowFindings] = useState(false);

  async function run(a: EscalationAction) {
    if (a.id === 'review_findings') { setShowFindings((v) => !v); return; }
    const path = ENDPOINT[a.id];
    if (!path) return;
    setBusy(a.id);
    setNote(null);
    try {
      const res = await fetch(`/api/prs/${prNumber}/${path}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setNote({ tone: 'err', text: data.error || `Could not ${a.label.toLowerCase()}.` });
      else { setNote({ tone: 'ok', text: DONE[a.id] ?? 'Done.' }); router.refresh(); }
    } catch {
      setNote({ tone: 'err', text: `Could not ${a.label.toLowerCase()}.` });
    } finally {
      setBusy(null);
    }
  }

  const groups: Array<[string, typeof brief.findings.open]> = [
    ['Open', brief.findings.open],
    ['Fix awaiting verification', brief.findings.addressedAwaitingVerification],
    ['Resolved', brief.findings.resolved],
  ];

  return (
    <section id="task-decision" data-testid="task-decision" data-cause={brief.cause} aria-label="Decision" className="card-decision mb-6 px-4 py-3 md:px-5">
      <h2 className="text-body font-semibold">{brief.title}</h2>
      <p className="mt-1 text-body text-text-secondary">{brief.summary}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-meta">
        {groups.map(([label, list]) => (
          <div key={label}><dt className="text-text-muted">{label}</dt><dd data-testid="decision-count" className="text-body font-medium">{list.length}</dd></div>
        ))}
      </dl>
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
      <ul className="mt-3 flex flex-col gap-3">
        {brief.actions.map((a) => (
          <li key={a.id} data-testid={`decision-action-${a.id}`} className="flex flex-col gap-1">
            <button
              type="button"
              disabled={!a.available || busy !== null || a.id === 'approve_override'}
              onClick={() => run(a)}
              className={`inline-flex min-h-11 w-full items-center justify-center border-2 px-4 text-body font-medium md:w-auto md:self-start ${a.id === 'request_fix' ? 'btn-primary' : 'border-border-strong text-text-primary hover:bg-surface-3'} disabled:opacity-50`}
            >
              {busy === a.id ? 'Working…' : a.label}
            </button>
            <p className="text-meta text-text-secondary">{a.impact}</p>
            <p className="text-meta text-text-muted">Needs: {a.requires}.{a.unavailableReason ? ` Unavailable: ${a.unavailableReason}` : ''}</p>
          </li>
        ))}
      </ul>
      {note && <p role="status" data-testid="decision-note" className={`mt-3 text-body ${note.tone === 'err' ? 'text-status-error' : 'text-text-primary'}`}>{note.text}</p>}
    </section>
  );
}
