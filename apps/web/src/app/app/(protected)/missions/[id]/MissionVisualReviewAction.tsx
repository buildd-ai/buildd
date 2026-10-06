'use client';

/**
 * "Visual review" in the mission header: the mission's visual review as a
 * mission command, available on any open mission, not only when completion is
 * blocked on a missing audit (that case is MissionDecisionSheet's "Run visual
 * audit"; both go through lib/mission-visual-review-request.ts).
 *
 * It never opens the generic task composer. The `[surface audit]` task is how
 * the command is carried out; the role, evidence contract, dependencies and
 * routes all come from POST /api/missions/[id]/surface-audit.
 *
 * - No audit yet: a short sheet of what the system already knows (screens,
 *   phone + desktop, where the pages come from, whether a browser runner is
 *   online) and one action, "Run visual review".
 * - An audit on the mission: the sheet is the review itself (the Tray, whose
 *   thumbnails open the deck). No second audit is offered; a re-check is a
 *   new round, opened by marking a screen as an issue in the review.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import SideSheet from '@/components/SideSheet';
import { missionTaskHref } from '@/lib/mission-task-href';
import {
  RUN_VISUAL_REVIEW_LABEL,
  VIEWPORT_LABEL,
  browserRunnerNote,
  captureSourceText,
  loadVisualReviewPreview,
  requestMissionVisualReview,
  visualReviewOnMission,
  visualReviewOutcomeText,
  type VisualReviewPreview,
  type VisualReviewRequestOutcome,
} from '@/lib/mission-visual-review-request';
import { MissionVisualTray, useMissionVisualReview, type MissionVisualReviewValue } from './MissionVisualReview';

const TRIGGER = 'inline-flex min-h-11 md:min-h-9 items-center gap-1.5 border-2 border-border-strong bg-surface-2 px-3 font-mono text-[12.5px] font-semibold text-text-primary hover:bg-surface-3';
const PRIMARY = 'inline-flex min-h-11 md:min-h-9 items-center justify-center bg-text-primary px-4 font-mono text-body font-semibold text-surface-1 hover:opacity-90 disabled:opacity-50';
const FACT_LABEL = 'w-20 shrink-0 text-text-muted';

export default function MissionVisualReviewAction({ missionId, initialOpen = false }: {
  missionId: string;
  /** `?visualReview=1`: arrive with the sheet open (a visual-review link from elsewhere). */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Visual review"
        data-testid="mission-visual-review-action"
        className={TRIGGER}
      >
        <span aria-hidden="true" className="text-accent-text">◫</span>
        {/* A phone header has room for one short word beside Ask. */}
        <span aria-hidden="true" className="md:hidden">Visual</span>
        <span aria-hidden="true" className="hidden md:inline">Visual review</span>
      </button>
      <SideSheet open={open} onClose={() => setOpen(false)} title="Visual review" testId="mission-visual-review-sheet">
        {open && <VisualReviewSheetBody missionId={missionId} onClose={() => setOpen(false)} />}
      </SideSheet>
    </>
  );
}

export function VisualReviewSheetBody({ missionId, onClose }: { missionId: string; onClose: () => void }) {
  const router = useRouter();
  const review = useMissionVisualReview(missionId);
  const [preview, setPreview] = useState<VisualReviewPreview | null>(null);
  const [loading, setLoading] = useState(!review);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VisualReviewRequestOutcome | null>(null);

  useEffect(() => {
    if (review) return;
    let live = true;
    loadVisualReviewPreview(missionId).then(p => {
      if (!live) return;
      setPreview(p);
      setLoading(false);
    });
    return () => { live = false; };
    // The plan is read once per opening; a review that appears replaces it.
  }, [missionId, !!review]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setBusy(true);
    const next = await requestMissionVisualReview(missionId);
    setOutcome(next);
    setBusy(false);
    // The page reloads its model: the Tray takes this sheet's place once it has one.
    if (visualReviewOnMission(next)) router.refresh();
  }

  const taskId = visualReviewOnMission(outcome) ? outcome.taskId : preview?.existing?.taskId ?? review?.model.audit?.id ?? null;
  const details = taskId ? (
    <a
      href={missionTaskHref({ missionId, taskId, mode: 'sheet' })}
      data-task-id={taskId}
      onClick={onClose}
      className="font-mono text-eyebrow text-text-muted underline hover:text-text-secondary"
      data-testid="visual-review-task-details"
    >
      Task details
    </a>
  ) : null;

  if (review) {
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="visual-review-surface" data-phase={review.model.phase}>
        {outcome && <OutcomeLine outcome={outcome} />}
        <MissionVisualTray review={closingDeck(review, onClose)} columns="one" />
        {review.model.phase === 'reviewed' && (
          <p className="text-meta text-text-muted">
            To check a screen again, mark it as an issue in the review. Its fix opens the next round.
          </p>
        )}
        {details}
      </div>
    );
  }

  const requested = visualReviewOnMission(outcome);
  const existing = preview?.existing ?? null;
  const note = preview ? browserRunnerNote(preview) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="visual-review-start">
      {!requested && !existing && (
        <p className="text-body text-text-secondary">
          Buildd opens the screens this mission changed at phone and desktop width, takes screenshots, and asks you about anything that looks wrong.
        </p>
      )}

      {loading ? (
        <p className="font-mono text-meta text-text-muted" role="status">Reading the mission…</p>
      ) : preview && !existing && !requested && (
        <dl className="flex flex-col gap-1.5 font-mono text-meta" data-testid="visual-review-facts">
          <div className="flex min-w-0 gap-2">
            <dt className={FACT_LABEL}>Screens</dt>
            <dd className="min-w-0 text-text-primary [overflow-wrap:anywhere]" data-testid="visual-review-routes">
              {preview.routes.length > 0
                ? preview.routes.join(', ')
                : 'Detected from the mission\'s changes'}
            </dd>
          </div>
          <div className="flex min-w-0 gap-2">
            <dt className={FACT_LABEL}>Widths</dt>
            <dd className="min-w-0 text-text-primary">{preview.viewports.map(v => VIEWPORT_LABEL[v]).join(' and ')}</dd>
          </div>
          {preview.capture && (
            <div className="flex min-w-0 gap-2">
              <dt className={FACT_LABEL}>Pages</dt>
              <dd className="min-w-0 text-text-primary [overflow-wrap:anywhere]" data-testid="visual-review-capture">{captureSourceText(preview.capture)}</dd>
            </div>
          )}
          {preview.browserRunnerOnline === true && !preview.executorLocal && (
            <div className="flex min-w-0 gap-2">
              <dt className={FACT_LABEL}>Runner</dt>
              <dd className="min-w-0 text-status-success">A runner with a browser is online</dd>
            </div>
          )}
        </dl>
      )}

      {note && !requested && !existing && (
        <p role="note" data-testid="visual-review-browser-note" className="border-l-[3px] border-status-warning py-1 pl-3 text-meta leading-[1.5] text-text-primary">
          {note}
        </p>
      )}

      {outcome && <OutcomeLine outcome={outcome} />}
      {!outcome && existing && (
        <OutcomeLine outcome={{ kind: 'existing', taskId: existing.taskId, status: existing.status }} />
      )}

      {!requested && !existing && (
        <div>
          <button
            type="button"
            onClick={run}
            disabled={busy || loading}
            data-testid="visual-review-run"
            className={PRIMARY}
          >
            {busy ? 'Adding…' : RUN_VISUAL_REVIEW_LABEL}
          </button>
        </div>
      )}
      {details}
    </div>
  );
}

function OutcomeLine({ outcome }: { outcome: VisualReviewRequestOutcome }) {
  const ok = visualReviewOnMission(outcome);
  return (
    <p
      role={ok ? 'status' : 'alert'}
      data-testid={ok ? 'visual-review-outcome' : 'visual-review-error'}
      data-outcome={outcome.kind}
      className={`text-meta [overflow-wrap:anywhere] ${ok ? 'text-text-secondary' : 'text-status-error'}`}
    >
      {visualReviewOutcomeText(outcome)}
    </p>
  );
}

/** The deck opens over the page (dialog at md+, the page's place below md), so this sheet closes first. */
function closingDeck(review: MissionVisualReviewValue, onClose: () => void): MissionVisualReviewValue {
  return { ...review, openDeck: (k, o) => { onClose(); review.openDeck(k, o); } };
}
