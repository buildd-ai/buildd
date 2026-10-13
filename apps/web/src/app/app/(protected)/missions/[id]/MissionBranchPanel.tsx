'use client';

/**
 * The mission branch panel: one compact block that says where the mission's
 * branch is in verification and what, if anything, a person owes it. It draws
 * a `VisualReviewPresentation` and nothing else; every word and every
 * "does this need you" answer comes from `presentVisualReview`
 * (lib/workflow/visual-review-copy.ts), so this and the stepper, Home, Health
 * and the chat tools cannot disagree. Hidden when it has nothing to say.
 *
 * It replaces the old visual-review setting row and its Line: the policy is a
 * workspace setting, not a per-mission switch the page repeats.
 */
import { useState } from 'react';
import StatePill from '@/components/ui/StatePill';
import type { StateKey } from '@/components/ui/states';
import type { BranchStage, VisualReviewPresentation } from '@/lib/workflow/visual-review-copy';

const STAGE_STATE: Record<BranchStage, StateKey> = {
  verifying: 'review',
  fixing: 'fixing',
  ready: 'landing',
  merged: 'landed',
  waiting: 'waiting',
};

export interface MissionBranchPanelProps {
  missionId: string;
  presentation: VisualReviewPresentation;
  /** Working branch name, shown as a mono caption. */
  branch?: string | null;
  integrationPr?: { number: number; href: string | null } | null;
  readonly?: boolean;
  /** A closed mission: the panel may stand as just the record line (a waiver or a no-impact decision). */
  showRecord?: boolean;
}

export default function MissionBranchPanel({ missionId, presentation: p, branch = null, integrationPr = null, readonly = false, showRecord = false }: MissionBranchPanelProps) {
  const [reported, setReported] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  if (!p.showPanel) {
    if (!showRecord || !p.recordLine) return null;
    return (
      <p data-testid="mission-branch-record" className="border-t border-border-default py-3 text-meta text-text-muted [overflow-wrap:anywhere]">
        {p.recordLine}
      </p>
    );
  }

  async function report() {
    setReported('sending');
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/visual-review/report`, { method: 'POST' });
      setReported(res.ok ? 'sent' : 'error');
    } catch {
      setReported('error');
    }
  }

  const state: StateKey = p.needsOwner && p.ownerDecision?.kind !== 'merge' ? 'needs_you' : STAGE_STATE[p.stage];

  return (
    <section
      data-testid="mission-branch-panel"
      data-stage={p.stage}
      data-needs-owner={p.needsOwner ? 'true' : 'false'}
      aria-label="Branch verification"
      className="min-w-0 border-t border-border-default py-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <StatePill state={state} label={p.stageLabel} data-testid="mission-branch-stage" />
        {integrationPr && (
          integrationPr.href
            ? <a href={integrationPr.href} className="font-mono text-meta text-text-muted underline hover:text-text-secondary">PR #{integrationPr.number}</a>
            : <span className="font-mono text-meta text-text-muted">PR #{integrationPr.number}</span>
        )}
        {branch && <span className="min-w-0 font-mono text-meta text-text-muted [overflow-wrap:anywhere]">{branch}</span>}
      </div>
      {p.detail && <p className="mt-1.5 text-body text-text-secondary" data-testid="mission-branch-detail">{p.detail}</p>}
      {p.autoDecisionRecord && <p className="mt-1.5 text-meta text-text-muted" data-testid="mission-branch-auto-decision">{p.autoDecisionRecord.line}</p>}
      {p.waiverRecord && <p className="mt-1.5 text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="mission-branch-waiver">{p.waiverRecord.line}</p>}
      {!readonly && p.ownerDecision?.kind === 'report' && (
        <div className="mt-2">
          {reported === 'sent' ? (
            <p role="status" className="text-meta text-text-secondary">Thanks. We have what we need to look into it.</p>
          ) : (
            <button
              type="button"
              onClick={() => void report()}
              disabled={reported === 'sending'}
              data-testid="mission-branch-report"
              className="inline-flex min-h-11 md:min-h-9 items-center border border-border-default px-3 font-mono text-meta text-text-primary hover:bg-surface-2 disabled:opacity-50"
            >
              {reported === 'sending' ? 'Sending…' : p.ownerDecision.label}
            </button>
          )}
          {reported === 'error' && <p role="alert" className="mt-1 text-meta text-status-error">Could not send the report. Try again.</p>}
        </div>
      )}
    </section>
  );
}
