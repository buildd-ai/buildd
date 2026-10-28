/**
 * How a mission's visual-review state reads to a person. Pure.
 *
 * Every surface (mission stepper and branch panel, Home / Needs You, Health,
 * the chat tools, completion and What shipped) renders this and nothing else,
 * so the words, the tone and "does this need the owner" cannot drift between
 * them. It reads `MissionVisualReviewState` (visual-review-state.ts) and
 * re-derives nothing from phases, globs or audit tasks.
 *
 * Rules the copy keeps:
 *  - the owner appears (`owner`, `needsYou`) only for an actual decision: Merge
 *    now where the merge policy asks a person, a visual judgment once the
 *    automatic fix rounds ran out, a workspace setup problem, a check that
 *    could not run after its automatic retries, or the one Run under `ask`.
 *    UI files changing, a queued audit or a flagged screen never raise it;
 *  - a product finding (`problem: 'product'`) is a different thing from the
 *    check failing to run (`problem: 'system'`), and only the latter offers
 *    "Report a Buildd problem";
 *  - no agent or task mechanics, file lists, raw codes or URLs in the words.
 */
import { uiDeltaLine } from './visual-review-carry';
import type {
  IntegrationPrStage,
  MissionVisualReviewState,
  VisualReviewBlockedCause,
  VisualReviewNextActor,
} from './visual-review-state';
import { claimHoldPhrase } from '../claim-hold-phrase';

export type VisualReviewStage = 'none' | 'verifying' | 'fixing' | 'ready' | 'merged' | 'blocked' | 'judgment' | 'waived';
export type VisualReviewTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export type VisualReviewOwnerKind = 'merge_now' | 'judge' | 'fix_setup' | 'report' | 'run_review';

export interface VisualReviewOwnerDecision {
  kind: VisualReviewOwnerKind;
  /** The button or line the owner reads. */
  label: string;
  detail: string | null;
}

export type VisualReviewRecord =
  /** A person skipped the review: reason, who, when and under which policy. */
  | { kind: 'waiver'; text: string; detail: string | null; reason: string; actor: string | null; at: string; policy: string }
  /** The system decided nothing on screen changed. Not a waiver. */
  | { kind: 'auto_no_impact'; text: string; detail: string | null }
  | { kind: 'passed'; text: string; detail: string | null };

export interface VisualReviewPresentation {
  stage: VisualReviewStage;
  tone: VisualReviewTone;
  label: string;
  detail: string | null;
  /** The compact branch panel is worth showing. */
  showPanel: boolean;
  nextActor: VisualReviewNextActor;
  /** A person genuinely owes something. Equal to `owner !== null`. */
  needsYou: boolean;
  owner: VisualReviewOwnerDecision | null;
  /** A recorded waiver is available to a person, quietly, beside a real owner decision. */
  canWaive: boolean;
  /** 'product': the screens have findings. 'system': the check itself failed or cannot run. */
  problem: 'product' | 'system' | null;
  /** Findings summary, for the review screens; null when the check failed rather than found. */
  findings: { issues: number; fixesOpen: number } | null;
  /** "Report a Buildd problem" for a system failure; never for a product finding. */
  report: { label: string; detail: string | null } | null;
  /** What the completion record keeps. */
  record: VisualReviewRecord | null;
  branch: { headSha: string | null; base: string | null; integrationPr: { number: number; stage: IntegrationPrStage | 'closed' } | null };
}

export interface PresentOptions {
  /** The merge policy asks a person to merge the integration PR (tier `human`). */
  ownerMergesIntegration?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const REPORT = { label: 'Report a Buildd problem', detail: 'Sends a short note about what failed. It carries no secrets or links.' } as const;

const BLOCKED_COPY: Record<VisualReviewBlockedCause, { label: string; detail: string }> = {
  preview_unavailable: { label: 'Preview unavailable', detail: 'The pages could not be opened. Check the preview setup for this workspace.' },
  capture_auth: { label: 'Preview needs access', detail: 'The pages need a sign-in or bypass the review does not have. Finish the preview setup for this workspace.' },
  no_browser_runner: { label: 'Waiting for a browser', detail: 'No runner with a browser is online to take the screenshots.' },
  app_boot_failed: { label: 'The app did not start', detail: 'The branch could not be started to take screenshots.' },
  stalled: { label: 'The visual check stalled', detail: 'It stopped making progress.' },
  auditor_failed: { label: 'The visual check failed', detail: 'It stopped before it could look at the screens.' },
  unknown: { label: 'The visual check could not run', detail: 'It stopped before it could look at the screens.' },
};

/** R-33: the claim loop's hold on a queued audit, as a sentence; null when none is known. */
function queuedHold(state: MissionVisualReviewState): string | null {
  if (state.status !== 'queued') return null;
  const phrase = claimHoldPhrase(state.holdReason);
  return phrase ? `${phrase[0].toUpperCase()}${phrase.slice(1)}.` : null;
}

/** The screens a merged fix waits on, named: one, or the first and how many more. */
function screensPhrase(all: readonly string[]): string {
  // Two shots of one screen are one screen to name.
  const screens = [...new Set(all)];
  if (screens.length === 0) return 'the fixed screens';
  return screens.length === 1 ? screens[0] : `${screens[0]} and ${plural(screens.length - 1, 'more screen')}`;
}

/** A closed mission's pass on an earlier commit, naming both commits when known. */
export function earlierCommitDetail(state: Pick<MissionVisualReviewState, 'evidenceSha' | 'branch'>): string {
  const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);
  const judged = short(state.evidenceSha);
  const delivered = short(state.branch.headSha);
  const passed = judged ? `It passed on ${judged} before the mission completed.` : 'It passed before the mission completed, on a commit the check did not record.';
  return `${passed} The delivered commit${delivered ? ` ${delivered}` : ''} was not checked again.`;
}

export function presentVisualReview(state: MissionVisualReviewState, opts: PresentOptions = {}): VisualReviewPresentation {
  const pr = state.branch.integrationPr;
  const prStage = pr?.stage ?? null;
  const common = { nextActor: state.nextActor, branch: { headSha: state.branch.headSha, base: state.branch.base, integrationPr: pr } };
  const quiet = {
    detail: null, owner: null, canWaive: false, problem: null, findings: null, report: null, record: null, needsYou: false,
  } as const;

  if (state.status === 'waived') {
    const w = state.waiver;
    return {
      ...quiet, ...common, stage: 'waived', tone: 'neutral', label: 'Visual check waived', showPanel: !!pr,
      detail: w ? waiverDetail(w) : null,
      record: w
        ? { kind: 'waiver', text: 'Visual check waived', detail: w.reason, reason: w.reason, actor: w.actorLabel, at: w.at, policy: state.policy.mode }
        : null,
    };
  }

  if (state.status === 'not_applicable') {
    return {
      ...quiet, ...common, stage: 'none', tone: 'neutral', label: 'No visual changes', showPanel: false,
      record: { kind: 'auto_no_impact', text: 'No visual changes', detail: 'Checked automatically. No visual review was needed.' },
    };
  }

  // Policy off: nothing is required, so nothing in flight is the owner's, whatever an earlier audit left behind.
  if (state.status === 'optional' || state.policy.mode === 'off') {
    return { ...quiet, ...common, stage: 'none', tone: 'neutral', label: 'Visual review is optional', showPanel: false };
  }

  if (state.status === 'passed') {
    const passedRecord: VisualReviewRecord = { kind: 'passed', text: 'Visual check passed', detail: state.scope.screens ? `${plural(state.scope.screens, 'screen')} checked.` : null };
    if (state.passedOnEarlierCommit) {
      const detail = earlierCommitDetail(state);
      return {
        ...quiet, ...common, stage: prStage === 'merged' ? 'merged' : 'none', tone: 'neutral', label: 'Visual check passed on an earlier commit',
        detail, showPanel: !!pr, record: { ...passedRecord, text: 'Visual check passed on an earlier commit', detail },
      };
    }
    if (prStage === 'merged') {
      return { ...quiet, ...common, stage: 'merged', tone: 'success', label: 'Merged', detail: 'Visual check passed before the merge.', showPanel: true, record: passedRecord };
    }
    if (prStage === 'ready') {
      const owner: VisualReviewOwnerDecision | null = opts.ownerMergesIntegration
        ? { kind: 'merge_now', label: 'Merge now', detail: 'The visual check passed on the latest changes.' }
        : null;
      return {
        ...quiet, ...common, stage: 'ready', tone: 'success', label: 'Ready to merge', detail: 'Visual check passed on the latest changes.',
        showPanel: true, record: passedRecord, owner, needsYou: !!owner, nextActor: owner ? 'owner' : state.nextActor,
      };
    }
    if (pr && prStage !== 'closed') {
      return { ...quiet, ...common, stage: 'verifying', tone: 'success', label: 'Visual check passed', detail: 'Waiting on the rest of the branch.', showPanel: true, record: passedRecord };
    }
    return { ...quiet, ...common, stage: 'none', tone: 'success', label: 'Visual check passed', showPanel: false, record: passedRecord };
  }

  if (state.status === 'blocked' && state.blocked) {
    const copy = BLOCKED_COPY[state.blocked.cause];
    const workspaceOwned = state.blocked.causeOwner === 'workspace';
    if (state.nextActor === 'owner') {
      const owner: VisualReviewOwnerDecision = workspaceOwned
        ? { kind: 'fix_setup', label: 'Fix preview setup', detail: copy.detail }
        : { kind: 'report', label: REPORT.label, detail: 'The check failed after automatic retries.' };
      return {
        ...quiet, ...common, stage: 'blocked', tone: 'warning', label: copy.label, detail: copy.detail, showPanel: true,
        owner, needsYou: true, canWaive: state.policy.waiverAllowed, problem: 'system', report: REPORT,
      };
    }
    // Nothing failed and nothing retries: the review is queued and the next browser runner to connect takes it.
    if (state.blocked.cause === 'no_browser_runner') {
      return { ...quiet, ...common, stage: 'blocked', tone: 'info', label: copy.label, detail: `${copy.detail} It starts when one connects.`, showPanel: true, problem: 'system' };
    }
    return {
      ...quiet, ...common, stage: 'blocked', tone: 'info', label: 'Retrying the visual check',
      detail: 'Something on our side failed. It tries again automatically.', showPanel: true, problem: 'system', report: REPORT,
    };
  }

  if (state.status === 'findings' && state.findings) {
    const f = state.findings;
    const findings = { issues: f.issues, fixesOpen: f.fixesOpen };
    if (f.carried) {
      // Policy `automatic`: the rounds are spent, nobody is asked, and the merge goes ahead.
      const n = Math.max(f.issues, state.recapture?.screens.length ?? 0, 1);
      return {
        ...quiet, ...common, stage: 'verifying', tone: 'info', label: n === 1 ? '1 screen is still open' : `${n} screens are still open`,
        detail: 'Automatic fixes did not settle these. The mission can merge. Each one is queued as a fix on the main branch.',
        showPanel: true, problem: 'product', findings,
      };
    }
    if (f.exhausted && state.recapture?.next === 'decide' && !state.findings.undecided) {
      // A merged fix no new screenshot will be taken of (spec 072de598 I-15).
      const n = state.recapture.screens.length;
      const owner: VisualReviewOwnerDecision = {
        kind: 'judge',
        label: `Check ${plural(n, 'fixed screen')}`,
        detail: `A new screenshot can no longer be taken automatically, so it needs your call. Fixed or Still broken: ${screensPhrase(state.recapture.screens)}.`,
      };
      return {
        ...quiet, ...common, stage: 'judgment', tone: 'warning', label: n === 1 ? 'A fix merged with no new screenshot' : `${n} fixes merged with no new screenshot`,
        detail: owner.detail, showPanel: true, owner, needsYou: true, canWaive: state.policy.waiverAllowed, problem: 'product', findings,
      };
    }
    if (f.exhausted) {
      const owner: VisualReviewOwnerDecision = {
        kind: 'judge',
        label: `Review ${plural(Math.max(f.issues, 1), 'screen')}`,
        detail: 'Automatic fixes did not settle these. It needs your call.',
      };
      return {
        ...quiet, ...common, stage: 'judgment', tone: 'warning', label: f.issues === 1 ? '1 screen still looks wrong' : `${Math.max(f.issues, 1)} screens still look wrong`,
        detail: owner.detail, showPanel: true, owner, needsYou: true, canWaive: state.policy.waiverAllowed, problem: 'product', findings,
      };
    }
    if (f.stage === 'fixing') {
      return {
        ...quiet, ...common, stage: 'fixing', tone: 'info', label: `Fixing ${plural(Math.max(f.issues, 1), 'issue')}`,
        detail: 'It checks again when the fixes land.', showPanel: true, problem: 'product', findings,
      };
    }
    // An agent decides unsure screens; the detail names what it waits on, never "no action needed" while it blocks.
    return {
      ...quiet, ...common, stage: 'verifying', tone: 'info', label: `Deciding on ${plural(Math.max(f.undecided, f.issues, 1), 'flagged screen')}`,
      detail: f.undecided > 0 ? `Waiting for a decision on ${plural(f.undecided, 'unsure screen')}.` : `Waiting for a decision on ${plural(Math.max(f.issues, 1), 'flagged screen')}.`,
      showPanel: true, problem: 'product', findings,
    };
  }

  // Never ran: build work it checks failed. Not a system problem, and nothing to retry here (spec 072de598 I-14).
  if (state.status === 'queued' && state.waitingOn) {
    const title = state.waitingOn.title?.trim();
    return {
      ...quiet, ...common, stage: 'verifying', tone: 'neutral', label: 'Waiting on failed work', showPanel: true,
      detail: `${title ? `“${title}”` : 'Build work it checks'} failed. The visual check starts once it completes.`,
    };
  }

  // needed / queued / running
  if (state.nextActor === 'owner') {
    const owner: VisualReviewOwnerDecision = { kind: 'run_review', label: 'Run visual review', detail: 'This workspace asks before checking screens.' };
    return {
      ...quiet, ...common, stage: 'verifying', tone: 'warning', label: 'Visual review is waiting for you',
      detail: owner.detail, showPanel: true, owner, needsYou: true,
    };
  }
  // A merged fix waiting for its screen to be shot again: name the screen (spec 072de598 I-15).
  if (state.recapture && state.recapture.next !== 'decide' && state.status !== 'running') {
    return {
      ...quiet, ...common, stage: 'verifying', tone: 'info', showPanel: true,
      label: `Waiting for a new screenshot of ${screensPhrase(state.recapture.screens)}`,
      detail: state.recapture.next === 'queued' ? queuedHold(state) ?? 'The capture is queued.' : 'The capture starts shortly.',
    };
  }
  const progress = state.progress;
  const detail = state.status === 'running' && progress
    ? progress.expected ? `Captured ${progress.captured} of ${progress.expected} screens.` : `Captured ${plural(progress.captured, 'screen')}.`
    : state.staleEvidence ? (state.uiDelta ? uiDeltaLine(state.uiDelta) : 'The branch changed since the last check.') : queuedHold(state) ?? 'Starts on the latest changes.';
  return {
    ...quiet, ...common, stage: 'verifying', tone: 'info', showPanel: !!pr || state.status !== 'needed',
    label: state.staleEvidence ? 'Checking the latest changes' : state.status === 'running' ? 'Checking screens' : 'Visual check queued',
    detail,
  };
}

/** Whether a mission's Needs You should list its visual review: only a real owner decision. */
export function visualReviewNeedsYou(state: MissionVisualReviewState | null | undefined, opts: PresentOptions = {}): boolean {
  return !!state && presentVisualReview(state, opts).needsYou;
}

/** The state in one plain line, for text surfaces (chat and MCP tools, completion notes). */
export function visualReviewStateLine(p: VisualReviewPresentation): string {
  const head = p.record?.kind === 'waiver' ? `${p.label}. Reason: ${p.record.reason}` : p.detail ? `${p.label}. ${p.detail}` : p.label;
  const tail = p.owner ? ` Waiting on ${p.owner.label}.` : '';
  return `${head}${/[.!?]$/.test(head) ? '' : '.'}${tail}`;
}

/**
 * A standing Skip in words (spec 072de598 I-7, I-18): who skipped it, which
 * button, their note, and the open findings under it, which never block.
 * Under Ship it anyway the findings were accepted; otherwise they are shown
 * for information. Never says passed.
 */
export function waiverDetail(w: NonNullable<MissionVisualReviewState['waiver']>): string {
  const who = w.actorLabel ?? 'A person';
  const why = w.skipReason === 'wrong_or_stuck' ? `${who} skipped it: the review is wrong or stuck.`
    : w.skipReason === 'ship_anyway' ? `${who} skipped it to ship anyway.`
    : `${who} skipped it.`;
  const note = w.skipReason ? w.note : w.reason;
  const n = w.openFindings;
  const findings = n <= 0 ? null
    : w.skipReason === 'ship_anyway' ? `${n} open ${n === 1 ? 'finding' : 'findings'} accepted.`
    : `${n} open ${n === 1 ? 'finding' : 'findings'} shown for information; ${n === 1 ? 'it does' : 'they do'} not block.`;
  return [why, note ? (/[.!?]$/.test(note) ? note : `${note}.`) : null, findings].filter(Boolean).join(' ');
}
