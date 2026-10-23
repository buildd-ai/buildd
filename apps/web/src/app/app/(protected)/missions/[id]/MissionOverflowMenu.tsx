'use client';

import type { MissionStartState } from '@/lib/mission-start-state';
import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import SideSheet from '@/components/SideSheet';
import MissionSettings, { type CompletionDecisionInfo } from './MissionSettings';
import { VisualReviewSheetBody } from './MissionVisualReviewAction';
import { useMissionLayout } from './MissionLayoutShell';
import type { MissionDisplayState } from '@/lib/mission-helpers';
import type { LivingSpecGoalCriterion } from '@buildd/shared';

interface Props {
  missionId: string;
  currentStatus: string;
  cronExpression: string | null;
  workspaceId: string | null;
  roles: { slug: string; name: string; color: string }[];
  hasSchedule: boolean;
  orchestrationMode?: 'auto' | 'manual';
  isHeld: boolean;
  /** A held mission: not started, or paused after it ran. */
  startState?: MissionStartState | null;
  displayState: MissionDisplayState;
  hasPrimaryAction?: boolean;
  executor?: 'runner' | 'local' | null;
  /** The mission's selected outcome specs; null hides the picker. */
  outcomeSpecs?: LivingSpecGoalCriterion[] | null;
  /** What Complete needs decided first (visual audit, unmet criteria); null on a finished mission. */
  completionDecision?: CompletionDecisionInfo | null;
  /** The mission's settings (workspace, schedule, backend, merge policy…), below the actions. */
  settings?: ReactNode;
  /**
   * Start or open the mission's visual review. Null on a finished mission or
   * one with no workspace to run it in. `initialOpen`: `?visualReview=1`
   * arrives with the review sheet open (a link from chat or elsewhere).
   */
  visualReview?: { initialOpen: boolean } | null;
}

const ROW = 'flex min-h-11 w-full items-center gap-2 border-t border-border-default text-left text-body text-text-primary hover:bg-card-hover';

/**
 * "⋯": the mission's one menu and settings sheet (Navigation d25d923d R-3).
 * First the page's own moves: History, Flow (from md), Re-check and Pause;
 * then the mission's actions (run, archive, delete, quick task), the visual
 * review, and every setting. Nothing about the mission is configured
 * anywhere else on the page.
 */
export default function MissionOverflowMenu({ settings, visualReview = null, ...props }: Props) {
  const [open, setOpen] = useState(false);
  const [visualOpen, setVisualOpen] = useState(visualReview?.initialOpen ?? false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="More: History, Flow, Re-check, Pause, settings"
        aria-haspopup="dialog"
        data-testid="mission-overflow-menu"
        className="shrink-0 w-11 h-11 -mr-2.5 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <circle cx="3.5" cy="9" r="1.5" />
          <circle cx="9" cy="9" r="1.5" />
          <circle cx="14.5" cy="9" r="1.5" />
        </svg>
      </button>
      <SideSheet open={open} onClose={() => setOpen(false)} title="Mission" testId="mission-actions-sheet">
        <div className="space-y-6">
          <PageMoves missionId={props.missionId} currentStatus={props.currentStatus} onClose={() => setOpen(false)} />
          <MissionSettings {...props} />
          {visualReview && (
            <button
              type="button"
              data-testid="mission-visual-review-entry"
              aria-haspopup="dialog"
              onClick={() => setVisualOpen(true)}
              className={ROW}
            >
              <span className="min-w-0 flex-1">Visual review</span>
              <span className="text-meta text-text-muted">Phone and desktop screens</span>
              <span aria-hidden="true" className="text-text-muted">›</span>
            </button>
          )}
          {settings && (
            <section aria-label="Settings" data-testid="mission-settings" className="space-y-5 border-t border-border-default pt-4">
              <h2 className="text-title font-semibold text-text-primary">Settings</h2>
              {settings}
            </section>
          )}
        </div>
      </SideSheet>
      {visualReview && (
        <SideSheet open={visualOpen} onClose={() => setVisualOpen(false)} title="Visual review" testId="mission-visual-review-sheet">
          {visualOpen && <VisualReviewSheetBody missionId={props.missionId} onClose={() => setVisualOpen(false)} />}
        </SideSheet>
      )}
    </>
  );
}

const TERMINAL = new Set(['completed', 'cancelled', 'archived']);

/**
 * The page's moves (R-3, R-6, R-19): History and Flow switch the layout
 * through the shell (Flow is a desktop view, so its row shows from md);
 * Re-check runs the mission's checks again for a fix made outside buildd;
 * Pause stops new work. An open mission only.
 */
function PageMoves({ missionId, currentStatus, onClose }: { missionId: string; currentStatus: string; onClose: () => void }) {
  const layout = useMissionLayout();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<'recheck' | 'pause' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const openMission = !TERMINAL.has(currentStatus);
  const paused = currentStatus === 'paused';

  async function recheck() {
    setBusy('recheck');
    setNote(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/evaluate`, { method: 'POST', credentials: 'include' });
      if (res.status === 429) setNote('Checked too often; try again within the hour.');
      else if (!res.ok) setNote(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not start the check.');
      else { setNote('Checking again.'); startTransition(() => router.refresh()); }
    } catch {
      setNote('Could not reach buildd.');
    } finally {
      setBusy(null);
    }
  }

  async function pause() {
    setBusy('pause');
    setNote(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ status: paused ? 'active' : 'paused' }),
      });
      if (!res.ok) setNote(paused ? 'Could not resume the mission.' : 'Could not pause the mission.');
      else { onClose(); startTransition(() => router.refresh()); }
    } catch {
      setNote('Could not reach buildd.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <nav aria-label="This page" data-testid="mission-page-moves" className="flex flex-col">
      {layout && (
        <>
          <button type="button" data-testid="mission-menu-history" data-layout="feed" onClick={() => { layout.setLayout('feed'); onClose(); }} className={ROW}>
            <span className="min-w-0 flex-1">History</span>
            <span className="text-meta text-text-muted">Every decision and run</span>
            <span aria-hidden="true" className="text-text-muted">›</span>
          </button>
          <button type="button" data-testid="mission-menu-flow" data-layout="flow" onClick={() => { layout.setLayout('flow'); onClose(); }} className={`${ROW} max-md:hidden`}>
            <span className="min-w-0 flex-1">Flow</span>
            <span className="text-meta text-text-muted">Tasks on one time axis</span>
            <span aria-hidden="true" className="text-text-muted">›</span>
          </button>
        </>
      )}
      {openMission && (
        <>
          <button type="button" data-testid="mission-menu-recheck" disabled={busy != null} onClick={() => void recheck()} className={ROW}>
            <span className="min-w-0 flex-1">{busy === 'recheck' ? 'Checking…' : 'Re-check'}</span>
            <span className="text-meta text-text-muted">Run the checks again</span>
          </button>
          <button type="button" data-testid="mission-menu-pause" disabled={busy != null} onClick={() => void pause()} className={ROW}>
            <span className="min-w-0 flex-1">{busy === 'pause' ? (paused ? 'Resuming…' : 'Pausing…') : paused ? 'Resume' : 'Pause'}</span>
            <span className="text-meta text-text-muted">{paused ? 'Start new work again' : 'No new work starts'}</span>
          </button>
        </>
      )}
      {note && <p role="status" className="py-2 font-mono text-meta text-text-secondary">{note}</p>}
    </nav>
  );
}
