/**
 * Plain copy and the owner-decision rule for a mission's visual-review state.
 * Pure, and the only place a surface gets words or a "does this need the owner"
 * answer from: the mission stepper, the branch panel, Home / Needs You, Health,
 * the chat tools and the completion record all call `presentVisualReview` on the
 * one `MissionVisualReviewState`, so none re-derives status from `phase` or
 * writes its own sentence.
 *
 * Rules the tests pin (docs/specs/mission-task-lifecycle.md, "Visual review"):
 * - Under an automatic policy the owner is never offered "run or waive", and a
 *   changed-UI glob alone never raises Needs You.
 * - The owner appears only for an authorized decision: merge, a review the
 *   policy asks for, a workspace setup problem, or a system failure that
 *   retrying did not clear.
 * - A product finding (the screens look wrong) and a system failure (the check
 *   itself could not run) never share a stage or a sentence.
 * - A waiver (a person's call) and a no-impact decision (the system's) are
 *   different records with different words.
 * - No copy names a task, an API, a glob, a URL or a SHA.
 */
import type { MissionVisualReviewState } from './visual-review-state';

export type BranchStage = 'verifying' | 'fixing' | 'ready' | 'merged' | 'waiting';

/** The one thing a person may be asked. `merge` is informational (it is the delivery action), the rest are asks. */
export type OwnerDecision =
  | { kind: 'merge'; label: 'Merge now' }
  | { kind: 'review'; label: 'Review screens' }
  | { kind: 'ask_policy'; label: 'Run visual review' }
  | { kind: 'setup'; label: 'Fix setup' }
  | { kind: 'report'; label: 'Report a Buildd problem' };

export type VisualProblem =
  | { kind: 'system'; cause: 'buildd' | 'workspace' | 'unknown'; retrying: boolean }
  | null;

export interface VisualReviewPresentation {
  /** Show the compact branch panel at all. False when there is nothing informative to say. */
  showPanel: boolean;
  stage: BranchStage;
  /** Short state word for the panel and stepper: Verifying / Fixing / Ready to merge / Merged. */
  stageLabel: string;
  /** One plain sentence under it; null when the label says it all. */
  detail: string | null;
  tone: 'neutral' | 'progress' | 'success' | 'warning';
  /** The owner has an authorized decision to make. Drives Needs You; false for a merge that is only ready. */
  needsOwner: boolean;
  ownerDecision: OwnerDecision | null;
  /** A system failure, kept apart from `findings`. */
  problem: VisualProblem;
  /** Product findings about the screens themselves. */
  findings: { issues: number; undecided: number; fixesOpen: number } | null;
  /** A person's waiver, for the completion record. */
  waiverRecord: { line: string } | null;
  /** The system's own "no visual impact" decision, for the completion record. */
  autoDecisionRecord: { line: string } | null;
  /** The line the completion record / What shipped carries; null when the review has no place there. */
  recordLine: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function dateOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : DATE.format(d);
}

const POLICY_WORD: Record<string, string> = { strict: 'strict', automatic: 'automatic', ask: 'ask first', off: 'off' };

export function waiverRecordLine(w: NonNullable<MissionVisualReviewState['waiver']>): string {
  const who = w.actorLabel ? ` by ${w.actorLabel}` : '';
  const when = dateOf(w.at);
  const policy = w.policy && POLICY_WORD[w.policy] ? ` Policy: ${POLICY_WORD[w.policy]}.` : '';
  return `Visual review waived${who}${when ? ` on ${when}` : ''}: ${w.reason}.${policy}`.replace(/\.\./g, '.');
}

const AUTO_BASIS_WORD: Record<string, string> = {
  rule: 'No screens were affected by the change.',
  model: 'The change was judged not to affect any screen.',
  policy: 'Visual review is off for this workspace.',
};

export function autoDecisionRecordLine(d: NonNullable<MissionVisualReviewState['autoDecision']>): string {
  return `Visual review not needed. ${AUTO_BASIS_WORD[d.basis] ?? ''}`.trim();
}

function problemOf(state: MissionVisualReviewState): VisualProblem {
  if (state.status !== 'blocked' || !state.blocked) return null;
  return { kind: 'system', cause: state.blocked.causeOwner, retrying: state.nextActor === 'system' };
}

export function presentVisualReview(state: MissionVisualReviewState): VisualReviewPresentation {
  const pr = state.branch.integrationPr;
  const prMerged = pr?.stage === 'merged';
  const prReady = pr?.stage === 'ready';
  const problem = problemOf(state);
  const findings = state.findings
    ? { issues: state.findings.issues, undecided: state.findings.undecided, fixesOpen: state.findings.fixesOpen }
    : null;
  const waiverRecord = state.waiver && state.status === 'waived' ? { line: waiverRecordLine(state.waiver) } : null;
  const autoDecisionRecord = state.autoDecision && state.status === 'not_applicable' ? { line: autoDecisionRecordLine(state.autoDecision) } : null;

  let stage: BranchStage = 'waiting';
  let stageLabel = 'Waiting';
  let detail: string | null = null;
  let tone: VisualReviewPresentation['tone'] = 'neutral';
  let ownerDecision: OwnerDecision | null = null;
  let needsOwner = false;

  const decide = (d: OwnerDecision) => { ownerDecision = d; needsOwner = d.kind !== 'merge'; };

  switch (state.status) {
    case 'needed':
    case 'queued':
    case 'running': {
      stage = 'verifying';
      stageLabel = 'Verifying';
      tone = 'progress';
      if (state.status === 'running' && state.progress && state.progress.expected) {
        detail = `Checked ${state.progress.captured} of ${plural(state.progress.expected, 'screen', 'screens')}.`;
      } else if (state.staleEvidence) {
        detail = 'The branch changed since the last check, so the screens are being checked again.';
      } else if (state.policy.mode === 'ask' && state.nextActor === 'owner') {
        // Only an ask policy puts the question to a person.
        detail = 'Your workspace asks before checking the screens.';
        decide({ kind: 'ask_policy', label: 'Run visual review' });
      } else {
        detail = 'The screens this branch changed are being checked.';
      }
      break;
    }
    case 'findings': {
      if (state.findings?.stage === 'fixing') {
        stage = 'fixing';
        stageLabel = 'Fixing';
        tone = 'progress';
        detail = `${plural(state.findings.issues, 'screen needs', 'screens need')} a fix. A fix is already in progress.`;
      } else {
        stage = 'verifying';
        stageLabel = 'Verifying';
        tone = 'progress';
        detail = state.nextActor === 'owner'
          ? `${plural(state.findings?.undecided ?? 0, 'screen needs', 'screens need')} your call.`
          : 'A screen needs a closer look. This is being handled.';
        if (state.nextActor === 'owner') decide({ kind: 'review', label: 'Review screens' });
      }
      break;
    }
    case 'blocked': {
      stage = 'verifying';
      stageLabel = 'Verifying';
      tone = 'warning';
      if (problem && problem.cause === 'workspace') {
        detail = 'The check could not open your app. A setup step needs attention.';
        decide({ kind: 'setup', label: 'Fix setup' });
      } else if (state.nextActor === 'owner') {
        detail = 'The check could not run, even after trying again.';
        decide({ kind: 'report', label: 'Report a Buildd problem' });
      } else {
        detail = 'The check hit a problem on our side and is trying again.';
      }
      break;
    }
    case 'passed':
    case 'waived':
    case 'not_applicable':
    case 'optional': {
      if (prMerged) { stage = 'merged'; stageLabel = 'Merged'; tone = 'success'; }
      else if (prReady) {
        stage = 'ready'; stageLabel = 'Ready to merge'; tone = 'success';
        decide({ kind: 'merge', label: 'Merge now' });
      } else if (pr) { stage = 'waiting'; stageLabel = 'In review'; }
      if (state.status === 'passed') detail = 'The screens were checked and look right.';
      else if (state.status === 'waived') detail = 'Visual review was waived.';
      break;
    }
  }

  // A merged branch with review still owed is recovery, not a gate.
  if (state.branch.postMergeRecovery) {
    stage = 'verifying';
    stageLabel = 'Verifying';
    detail = 'Merged. The screens are still being checked.';
  }

  const hasBranchStory = !!pr || state.status === 'waived' || state.status === 'passed' || state.pendingVerification;
  const showPanel = hasBranchStory && state.status !== 'not_applicable' && !(state.status === 'optional' && !pr);

  const recordLine = waiverRecord?.line ?? autoDecisionRecord?.line
    ?? (state.status === 'passed' ? 'Visual review passed.' : null);

  return {
    showPanel,
    stage,
    stageLabel,
    detail,
    tone,
    needsOwner,
    ownerDecision,
    problem,
    findings,
    waiverRecord,
    autoDecisionRecord,
    recordLine,
  };
}

/** The presentation reduced to what a text surface (chat, MCP) prints: no component, no ids. */
export interface BranchSummary {
  stageLabel: string;
  detail: string | null;
  needsOwner: boolean;
  /** The owner's one authorized action, by label; null when nothing is asked of them. */
  ask: string | null;
  recordLine: string | null;
}

export function branchSummary(state: MissionVisualReviewState): BranchSummary | null {
  const p = presentVisualReview(state);
  if (!p.showPanel && !p.recordLine) return null;
  return {
    stageLabel: p.stageLabel,
    detail: p.detail,
    needsOwner: p.needsOwner,
    ask: p.ownerDecision && p.ownerDecision.kind !== 'merge' ? p.ownerDecision.label : null,
    recordLine: p.recordLine,
  };
}

/**
 * What "Report a Buildd problem" sends. Closed field list, no free text from
 * the page, no URLs, no commit ids: enough for a person on our side to tell a
 * platform fault from a setup one, and nothing a token could ride in on.
 */
export interface VisualReviewDiagnostics {
  status: MissionVisualReviewState['status'];
  policy: MissionVisualReviewState['policy']['mode'];
  cause: NonNullable<MissionVisualReviewState['blocked']>['cause'] | null;
  causeOwner: NonNullable<MissionVisualReviewState['blocked']>['causeOwner'] | null;
  retriesLeft: number | null;
  integrationPr: NonNullable<MissionVisualReviewState['branch']['integrationPr']>['stage'] | null;
  staleEvidence: boolean;
  screens: number | null;
}

export function visualReviewDiagnostics(state: MissionVisualReviewState): VisualReviewDiagnostics {
  return {
    status: state.status,
    policy: state.policy.mode,
    cause: state.blocked?.cause ?? null,
    causeOwner: state.blocked?.causeOwner ?? null,
    retriesLeft: state.blocked?.autoRetriesLeft ?? null,
    integrationPr: state.branch.integrationPr?.stage ?? null,
    staleEvidence: state.staleEvidence,
    screens: state.scope.screens,
  };
}
