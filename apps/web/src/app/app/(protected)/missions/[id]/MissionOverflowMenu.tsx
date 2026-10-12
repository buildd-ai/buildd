'use client';

import { useState, type ReactNode } from 'react';
import SideSheet from '@/components/SideSheet';
import MissionSettings, { type CompletionDecisionInfo } from './MissionSettings';
import { VisualReviewSheetBody } from './MissionVisualReviewAction';
import type { MissionDisplayState } from '@/lib/mission-helpers';

interface Props {
  missionId: string;
  currentStatus: string;
  cronExpression: string | null;
  workspaceId: string | null;
  roles: { slug: string; name: string; color: string }[];
  hasSchedule: boolean;
  orchestrationMode?: 'auto' | 'manual';
  isHeld: boolean;
  displayState: MissionDisplayState;
  hasPrimaryAction?: boolean;
  executor?: 'runner' | 'local' | null;
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
 * "⋯": the mission's one settings sheet. Its actions (run, pause, archive,
 * delete, quick task), the visual review, then every setting. Nothing about
 * the mission is configured anywhere else on the page.
 */
export default function MissionOverflowMenu({ settings, visualReview = null, ...props }: Props) {
  const [open, setOpen] = useState(false);
  const [visualOpen, setVisualOpen] = useState(visualReview?.initialOpen ?? false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Mission actions and settings"
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
