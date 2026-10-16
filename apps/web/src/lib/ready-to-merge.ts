/**
 * The one ready-to-merge decision for a mission's integration PR.
 *
 * Every merge door (auto-merge, `merge_pr`, the dashboard merge button, the
 * kernel landing lane, the CI-green webhook) already asks `guardMissionPrMerge`
 * about the mission PR. That guard builds the facts and delegates here, so the
 * conditions live in one place and a door cannot grow its own. Pure.
 *
 * What it decides, in order, all for the commit being merged:
 *  1. the mission's work is finished (no open task PR on the integration branch,
 *     no deliverable task without a PR);
 *  2. the visual review is not owed. Owed means required by policy and not
 *     passed or waived on THIS head: a pass on an older commit is not evidence.
 *
 * What it does not do, on purpose:
 *  - Gate a task PR into the integration branch. Only the mission PR is asked
 *    (the guard returns early for anything else), so approved task PRs still land.
 *  - Gate opening or reviewing the mission PR. It answers "may this land", and
 *    `openMissionIntegrationPr` never consults it, so there is no circular wait:
 *    the review runs on the open PR's head, then the merge is allowed.
 *  - Restate CI, the code reviewer's verdict or the protected-path / migration /
 *    spend rails. Those stay per-door rails (`guardReviewVerdict`, the safety
 *    evaluation) that a door runs for ANY PR; this adds the mission-level
 *    conditions. No input here is a person's or Jev's say-so: a waiver is the
 *    only person-recorded fact, and the policy decides whether one is allowed
 *    (never under strict). A mandatory check is never skippable from here.
 *  - Block an integration PR that already merged. Then the review is recovery
 *    (`postMergeRecovery`), reported as such and never as pre-merge assurance.
 */
import type { MissionVisualReviewState, VisualReviewNextActor } from './workflow/visual-review-state';

export type ReadyToMergeBlockerCode =
  | 'work_unfinished'
  | 'visual_review_owed'
  | 'visual_review_stale'
  | 'visual_review_findings'
  | 'visual_review_blocked'
  | 'visual_state_unreadable';

export interface ReadyToMergeBlocker {
  code: ReadyToMergeBlockerCode;
  reason: string;
  nextActor: VisualReviewNextActor;
}

export type ReadyToMergeFacts =
  | { kind: 'not_mission_pr' }
  | {
      kind: 'mission_integration_pr';
      /** Why the mission's work is not finished, or null when it is (`guardMissionPrMerge`). */
      workHolder: string | null;
      /** `null` = the state could not be read. */
      visual: MissionVisualReviewState | null;
    };

export interface ReadyToMergeDecision {
  ready: boolean;
  blockers: ReadyToMergeBlocker[];
  /** True when the visual review should be (re)filed because a door just found it owed. */
  scheduleVisualReview: boolean;
}

const BLOCKED_ACTOR = (s: MissionVisualReviewState): VisualReviewNextActor => (s.nextActor === 'none' ? 'system' : s.nextActor);

export function decideReadyToMerge(facts: ReadyToMergeFacts): ReadyToMergeDecision {
  if (facts.kind === 'not_mission_pr') return { ready: true, blockers: [], scheduleVisualReview: false };

  const blockers: ReadyToMergeBlocker[] = [];
  if (facts.workHolder) blockers.push({ code: 'work_unfinished', reason: facts.workHolder, nextActor: 'system' });

  const v = facts.visual;
  let scheduleVisualReview = false;
  if (!v) {
    // Fail closed: the review is a pre-merge check, and a merge cannot be told from here that it is not owed.
    blockers.push({
      code: 'visual_state_unreadable',
      reason: 'The visual review state could not be read, so it cannot be shown that this commit was reviewed. Try again shortly.',
      nextActor: 'system',
    });
  } else if (v.pendingVerification && v.branch.integrationPr?.stage !== 'merged') {
    const where = v.branch.headSha ? ` on commit ${v.branch.headSha.slice(0, 8)}` : '';
    if (v.status === 'findings') {
      blockers.push({
        code: 'visual_review_findings',
        reason: `The visual review found issues${where} that are not resolved yet (${v.findings?.stage === 'fixing' ? 'fixes are in progress' : 'a decision is pending'}). It re-runs on the fixed commit before this can merge.`,
        nextActor: BLOCKED_ACTOR(v),
      });
    } else if (v.status === 'blocked') {
      blockers.push({
        code: 'visual_review_blocked',
        reason: `The visual review could not run${where} (${(v.blocked?.cause ?? 'unknown').replace(/_/g, ' ')}). It is not skipped: ${v.nextActor === 'owner' ? 'someone has to fix the setup' : 'buildd retries it'}.`,
        nextActor: BLOCKED_ACTOR(v),
      });
    } else if (v.staleEvidence) {
      blockers.push({
        code: 'visual_review_stale',
        reason: `The last visual review looked at an older commit than this one${where}. A new review of this commit is required before it merges.`,
        nextActor: BLOCKED_ACTOR(v),
      });
      scheduleVisualReview = true;
    } else {
      blockers.push({
        code: 'visual_review_owed',
        reason: v.status === 'needed'
          ? `This mission changes what people see and its visual review has not run${where}. It is filed automatically and the merge proceeds once it passes.`
          : `The visual review is ${v.status}${where} and has to pass before this merges.`,
        nextActor: BLOCKED_ACTOR(v),
      });
      scheduleVisualReview = v.status === 'needed';
    }
  }

  return { ready: blockers.length === 0, blockers, scheduleVisualReview };
}

/** The blockers as the single sentence a door shows. */
export function readyToMergeReason(d: ReadyToMergeDecision): string {
  return d.blockers.map(b => b.reason).join(' ');
}
