/**
 * The `?state=visual-review` dev fixture: the visual review component family
 * (components/visual-review/, docs/design/visual-qa-human-review.md) over
 * the fixture models in lib/visual-review-model.fixtures.ts.
 *
 *   ?state=visual-review&phase=<phase>        Line + Ask + Tray for a phase
 *   &reason=question|unsure|round_cap         which needs_you
 *   &view=board                               embedded like the mission board
 *   &view=deck | deck-phone | compare         the review deck (dialog, inline sheet, compare open)
 *   &view=reviewed                            the reviewed tray
 *   &expired=1                                one image that fails to load
 *
 * Illustrative fixtures only: SVG sketches, never captures (the repo is
 * public). Decisions go to an in-memory transport, never the network.
 */
import { VISUAL_REVIEW_PHASES, type VisualReviewNeedsYouReason, type VisualReviewPhase } from '@buildd/shared';
import type { VisualReviewFixtureOptions } from '@/lib/visual-review-model.fixtures';
import { mockWorkers } from './fixtures-data';

export const VISUAL_REVIEW_FIXTURE_STATE = 'visual-review';
/** The real mission Board, Lanes and Feed with a visual model (mission-board-visual-fixtures.ts). */
export const MISSION_BOARD_VISUAL_FIXTURE_STATE = 'mission-board-visual';

/** Every `?state=` the fixtures page understands. */
/** The missions-list cards under each executor (mission-list-executor-fixtures.ts). */
export const MISSION_LIST_EXECUTOR_FIXTURE_STATE = 'mission-list-executor';
/** The mission Settings sheet's check-ins and organizer runs (MissionCheckInsFixture.tsx). */
export const MISSION_CHECK_INS_FIXTURE_STATE = 'mission-check-ins';
/** The task page's Evidence files section in each state (TaskEvidenceFilesFixture.tsx). */
export const TASK_EVIDENCE_FIXTURE_STATE = 'task-evidence';

/** Settings → Storage with fixture backends (EvidenceStorageFixture.tsx). */
export const EVIDENCE_STORAGE_FIXTURE_STATE = 'evidence-storage';

/** The completed task page's What shipped header, and Checks by commit (task-shipped-fixtures.ts). */
export const TASK_SHIPPED_FIXTURE_STATE = 'task-shipped';
export const COMMIT_CHECKS_FIXTURE_STATE = 'commit-checks';

/** A question's answer pending, recorded, already answered and failed (AnswerStatesFixture.tsx). */
export const ANSWER_STATES_FIXTURE_STATE = 'answer-states';

export const FIXTURE_VIEWS: readonly string[] = [...Object.keys(mockWorkers), VISUAL_REVIEW_FIXTURE_STATE, MISSION_BOARD_VISUAL_FIXTURE_STATE, MISSION_LIST_EXECUTOR_FIXTURE_STATE, MISSION_CHECK_INS_FIXTURE_STATE, TASK_EVIDENCE_FIXTURE_STATE, EVIDENCE_STORAGE_FIXTURE_STATE, TASK_SHIPPED_FIXTURE_STATE, COMMIT_CHECKS_FIXTURE_STATE, ANSWER_STATES_FIXTURE_STATE];

export function isFixtureView(value: string | null | undefined): value is string {
  return value != null && FIXTURE_VIEWS.includes(value);
}

export const VISUAL_REVIEW_FIXTURE_VIEWS = ['tray', 'board', 'deck', 'deck-phone', 'compare', 'reviewed'] as const;
export type VisualReviewFixtureView = (typeof VISUAL_REVIEW_FIXTURE_VIEWS)[number];

const REASONS: readonly VisualReviewNeedsYouReason[] = ['unsure', 'question', 'round_cap'];

export interface VisualReviewFixtureParams {
  view: VisualReviewFixtureView;
  phase: VisualReviewPhase;
  options: VisualReviewFixtureOptions;
  /** The deck opens on this cell. */
  startKey: string | null;
  compare: boolean;
}

/** The compare view opens on the route the second round re-shot. */
export const COMPARE_START_KEY = '/app/tasks/:id|mobile|';

/** Pure: `?view=&phase=&reason=&expired=` to what the page renders. Unknown values fall back. */
export function parseVisualReviewFixtureParams(q: URLSearchParams): VisualReviewFixtureParams {
  const viewParam = q.get('view');
  const view: VisualReviewFixtureView = (VISUAL_REVIEW_FIXTURE_VIEWS as readonly string[]).includes(viewParam ?? '')
    ? (viewParam as VisualReviewFixtureView)
    : 'tray';
  const phaseParam = q.get('phase');
  const reasonParam = q.get('reason');
  const reason = (REASONS as readonly string[]).includes(reasonParam ?? '') ? (reasonParam as VisualReviewNeedsYouReason) : undefined;
  const expired = q.get('expired') === '1';
  const deckLike = view === 'deck' || view === 'deck-phone' || view === 'compare';

  if (view === 'reviewed') {
    return { view, phase: 'reviewed', options: { expired }, startKey: null, compare: false };
  }
  if (deckLike) {
    // The two-round working set with mixed human reviews.
    return {
      view,
      phase: 'needs_you',
      options: { needsYou: 'unsure', scenario: 'deck', expired },
      startKey: view === 'compare' ? COMPARE_START_KEY : null,
      compare: view === 'compare',
    };
  }
  const phase = (VISUAL_REVIEW_PHASES as readonly string[]).includes(phaseParam ?? '') ? (phaseParam as VisualReviewPhase) : 'needs_you';
  const options: VisualReviewFixtureOptions = { expired };
  if (phase === 'needs_you') {
    options.needsYou = reason ?? 'unsure';
    if (options.needsYou === 'unsure') options.scenario = 'deck';
  }
  return { view, phase, options, startKey: null, compare: false };
}

/** The fixture links the page shows: every phase, then the deck and board views. */
export function visualReviewFixtureLinks(): { label: string; href: string }[] {
  const base = `?state=${VISUAL_REVIEW_FIXTURE_STATE}`;
  return [
    ...VISUAL_REVIEW_PHASES.filter(p => p !== 'needs_you').map(p => ({ label: p, href: `${base}&phase=${p}` })),
    ...REASONS.map(r => ({ label: `needs_you: ${r}`, href: `${base}&phase=needs_you&reason=${r}` })),
    { label: 'board', href: `${base}&view=board` },
    { label: 'deck', href: `${base}&view=deck` },
    { label: 'deck-phone', href: `${base}&view=deck-phone` },
    { label: 'compare', href: `${base}&view=compare` },
    { label: 'reviewed', href: `${base}&view=reviewed` },
    { label: 'expired', href: `${base}&view=deck-phone&expired=1` },
  ];
}
