'use client';

/**
 * The mission's branch and visual-check state in one compact block, read off
 * the canonical presentation (`presentVisualReview`) and nothing else. It
 * renders only when `presentation.showPanel`: a branch with nothing to say
 * about its visual check shows nothing here.
 *
 * Content: the state in a sentence (Verifying, Fixing, Ready to merge, Merged,
 * a stuck check), the branch and its integration PR, and, only when a person
 * genuinely owes something, the one action for it. A failed check offers
 * "Report a Buildd problem", which is a different thing from a screen finding.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestMissionVisualReview } from '@/lib/mission-visual-review-request';
import type { VisualReviewPresentation, VisualReviewTone } from '@/lib/workflow/visual-review-presentation';

const TONE_TEXT: Record<VisualReviewTone, string> = {
  neutral: 'text-text-secondary',
  info: 'text-status-info',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
};
const GLYPH: Record<VisualReviewTone, string> = { neutral: '○', info: '◐', success: '●', warning: '◐', error: '✕' };

export interface MissionBranchPanelProps {
  missionId: string;
  presentation: VisualReviewPresentation;
  /** The integration PR on GitHub, for Merge now. */
  prUrl?: string | null;
  /** Where the preview setup lives, for a workspace-owned problem. */
  workspaceSettingsHref?: string | null;
  readonly?: boolean;
}

export default function MissionBranchPanel({ missionId, presentation: p, prUrl = null, workspaceSettingsHref = null, readonly = false }: MissionBranchPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!p.showPanel) return null;

  const { branch } = p;
  const facts = [
    branch.base ? `into ${branch.base}` : null,
    branch.integrationPr ? `PR #${branch.integrationPr.number}` : null,
    branch.headSha ? branch.headSha.slice(0, 7) : null,
  ].filter(Boolean).join(' · ');

  async function runReview() {
    setBusy(true);
    setError(null);
    const out = await requestMissionVisualReview(missionId);
    setBusy(false);
    if (out.kind === 'refused') setError('Could not start the visual review. Try again.');
    else router.refresh();
  }

  async function report() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/visual-review/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('refused');
      setReported(true);
    } catch {
      setError('Could not send the report. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const owner = readonly ? null : p.owner;
  return (
    <section data-testid="mission-branch-panel" data-stage={p.stage} aria-label="Branch and visual check" className="flex flex-col gap-1.5 border-t border-border-default pt-3">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body">
        <span aria-hidden="true" className={`font-mono ${TONE_TEXT[p.tone]}`}>{GLYPH[p.tone]}</span>
        <span data-testid="mission-branch-panel-label" className="font-semibold text-text-primary">{p.label}</span>
        {p.detail && <span data-testid="mission-branch-panel-detail" className="min-w-0 text-text-secondary">{p.detail}</span>}
      </p>
      {facts && <p className="font-mono text-meta text-text-muted [overflow-wrap:anywhere]" data-testid="mission-branch-panel-facts">{facts}</p>}

      {(owner || (p.report && !readonly)) && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {owner?.kind === 'merge_now' && prUrl && (
            <a className="btn btn-sm" href={prUrl} target="_blank" rel="noreferrer" data-testid="mission-branch-merge">{owner.label}</a>
          )}
          {owner?.kind === 'run_review' && (
            <button type="button" className="btn btn-sm" onClick={runReview} disabled={busy} data-testid="mission-branch-run">{busy ? 'Starting…' : owner.label}</button>
          )}
          {owner?.kind === 'judge' && (
            <a className="btn btn-sm" href="?visualReview=1" data-testid="mission-branch-judge">{owner.label}</a>
          )}
          {owner?.kind === 'fix_setup' && workspaceSettingsHref && (
            <a className="btn btn-sm" href={workspaceSettingsHref} data-testid="mission-branch-setup">{owner.label}</a>
          )}
          {p.report && !readonly && !reported && (
            <button
              type="button"
              className={owner?.kind === 'report' ? 'btn btn-sm' : 'font-mono text-eyebrow text-text-muted underline hover:text-text-secondary'}
              onClick={report}
              disabled={busy}
              data-testid="mission-branch-report"
            >
              {p.report.label}
            </button>
          )}
          {reported && <span role="status" className="font-mono text-meta text-text-secondary" data-testid="mission-branch-reported">Report sent.</span>}
        </div>
      )}
      {error && <p role="alert" className="font-mono text-meta text-status-error">{error}</p>}
    </section>
  );
}
