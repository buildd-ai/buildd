/**
 * Alerting for the PR landing guarantee (knowledge-base: buildd/design/pr-landing-guarantee.md §H).
 *
 * `landPr` decides; this decides whether that deserves a person. Exactly one
 * Pushover per (workspace, PR, head, reason), and none for a PR that is
 * progressing. Pure policy plus injected effects: the database-bound deps live
 * in `pr-landing-alert-deps.ts`, so this file imports nothing that touches a
 * connection and the confirm screen can share its action vocabulary.
 */

import type { LandingOutcome, HumanCause, FixKind } from '@/lib/pr-landing';
import { signLandingActionToken, type LandingAction } from '@/lib/landing-action-token';

/** A fix task nobody claimed or pushed from within this long is the operator's problem. */
export const FIX_PICKUP_BOUND_MS = 30 * 60_000;
/**
 * Still not merged and no landing progress for this long, whatever the outcome says.
 * Measured from the last progress (see `progressFingerprint`), not from when the
 * PR was first held: a refreshed head with CI running is a PR landing, not a stuck one.
 */
export const INVARIANT_ALARM_MS = 45 * 60_000;

/** `needs_human:<cause>` | `fix_stuck:<fix>` | `invariant`. */
export type PageReason = string;

/** Not paged: a human-tier PR is already in the person's queue, the rest are momentary and the invariant alarm catches them if they persist. */
const UNPAGED_CAUSES: ReadonlySet<HumanCause> = new Set(['human_tier', 'landing_error', 'github_unreadable', 'pr_closed']);

const CAUSE_WORDS: Partial<Record<HumanCause, string>> = {
  refresh_exhausted: 'it lost the race to the base branch',
  refresh_failed: 'its branch could not be updated from the base (not a conflict)',
  semantic_unverified: 'it and the base edit the same files and the overlap could not be verified',
  fix_exhausted: 'the automatic fixes ran out of attempts',
  blocking_verdict: 'the reviewer is blocking it',
  low_confidence: 'the review is not confident enough',
  review_failed: 'the review did not finish',
  deny_path: 'it touches a protected path',
  size_cap: 'it is larger than the auto-merge limit',
  branch_protection: 'branch protection is blocking the merge',
  migration: 'it carries a migration that needs a person',
  unsafe_other: 'a safety rule needs a person to look',
  superseded: 'the change is already upstream',
  dependency_bot: 'a dependency update needs a person',
  base_rewritten: 'the base branch was rewritten',
  auto_resolve_disabled: 'automatic conflict fixing is turned off',
  no_owner: 'no task owns it',
  merge_failed: 'the merge itself failed',
};

const FIX_WORDS: Record<FixKind, string> = {
  ci_fix: 'its CI fix was not picked up',
  conflict: 'its conflict fix was not picked up',
  re_review: 'its re-review was not picked up',
  renumber_migration: 'its migration renumber was not picked up',
};

export const LANDING_ACTION_LABELS: Record<LandingAction, string> = {
  ci_fix: 'Dispatch CI fix',
  conflict: 'Resolve conflicts',
  re_review: 'Re-review',
  retry_landing: 'Retry landing',
  merge_anyway: 'Merge anyway',
  close_superseded: 'Close as superseded',
  review_on_github: 'Review on GitHub',
};

export interface ActionPlan {
  /** What one tap from the notification proposes. */
  primary: LandingAction;
  /** Everything the confirm screen offers, primary first. */
  options: LandingAction[];
}

type Override = { verdict?: boolean; size?: boolean; freshness?: boolean };

/** The override `landPr` honours for a "merge anyway" on this cause, or null when a person may not override it. */
const MERGE_ANYWAY: Record<string, Override> = {
  'needs_human:refresh_exhausted': { freshness: true },
  'needs_human:size_cap': { size: true },
  'needs_human:blocking_verdict': { verdict: true },
  'needs_human:low_confidence': { verdict: true },
};

export function overrideForAction(reason: PageReason, action: LandingAction): Override | null {
  if (action === 'merge_anyway') return MERGE_ANYWAY[reason] ?? null;
  // A link, not a server action: nothing to run.
  if (action === 'review_on_github') return null;
  return {};
}

export function actionsForReason(reason: PageReason): ActionPlan {
  const [family, detail = ''] = reason.split(':');
  const withOverride = (primary: LandingAction, rest: LandingAction[] = []): ActionPlan => ({
    primary,
    options: [primary, ...rest, ...(MERGE_ANYWAY[reason] && primary !== 'merge_anyway' ? (['merge_anyway'] as const) : [])],
  });

  if (family === 'fix_stuck') {
    if (detail === 'ci_fix') return { primary: 'ci_fix', options: ['ci_fix'] };
    if (detail === 're_review') return { primary: 're_review', options: ['re_review'] };
    return { primary: 'conflict', options: ['conflict'] };
  }
  if (family === 'needs_human') {
    switch (detail) {
      case 'fix_exhausted':
        return { primary: 'conflict', options: ['conflict', 'close_superseded'] };
      case 'superseded':
        return { primary: 'close_superseded', options: ['close_superseded', 'retry_landing'] };
      case 'blocking_verdict':
      case 'low_confidence':
        return withOverride('re_review');
      case 'review_failed':
        return { primary: 're_review', options: ['re_review'] };
      case 'size_cap':
        return withOverride('retry_landing');
      // buildd never merges past these (landPr refuses a protected path or a
      // migration for every door), so retrying the same commit cannot change
      // the outcome. The person reviews the diff and merges it on GitHub.
      case 'deny_path':
      case 'migration':
        return { primary: 'review_on_github', options: ['review_on_github'] };
      // These can clear once the person acts on GitHub (an approval, a look at
      // the dependency bump), so a retry stays on offer for afterwards.
      case 'branch_protection':
      case 'dependency_bot':
      case 'unsafe_other':
        return { primary: 'review_on_github', options: ['review_on_github', 'retry_landing'] };
      default:
        return withOverride('retry_landing');
    }
  }
  return { primary: 'retry_landing', options: ['retry_landing'] };
}

export interface LandingAlertInput {
  workspaceId: string;
  prNumber: number;
  /** The live head the outcome was decided against. */
  headSha: string;
  repoFullName: string;
  prTitle: string | null;
  /** The owning task: where the dedupe key and the clocks live. Without one nothing can be deduped, so nothing is sent. */
  taskId: string | null;
  outcome: LandingOutcome;
  approvedAt?: string | null;
  /** The check-run state landing read on `headSha`; null/absent when it did not get that far. */
  checks?: ChecksState | null;
  /** The reason landing gave for this outcome, so a stuck page can name what it is waiting on. */
  outcomeReason?: string | null;
  /** For re-reading the live head just before a send. */
  installationId?: number;
}

export type ChecksState = 'green' | 'pending' | 'red';

export interface PagePayload {
  title: string;
  message: string;
  url: string;
  urlTitle: string;
  priority: 0 | 1;
}

export interface LandingAlertDeps {
  now: () => number;
  /** The ISO time a named clock first started for this task. `startIfAbsent` starts it now; absent and not starting → null. */
  observe: (taskId: string, key: string, nowIso: string, startIfAbsent: boolean) => Promise<string | null>;
  /**
   * The ISO time the landing state last changed: records `fingerprint` as current
   * and returns when it became current (now, when it differs from the stored one).
   */
  markProgress: (taskId: string, fingerprint: string, nowIso: string) => Promise<string>;
  /** When the newest review round on the PR was dispatched or concluded (epoch ms), or null. */
  lastReviewAt?: (workspaceId: string, prNumber: number) => Promise<number | null>;
  /** The PR's head right now, or null when it cannot be read. A page for any other head is stale. */
  readLiveHead?: (input: LandingAlertInput) => Promise<string | null>;
  /** Whether any page was already sent for this head (`<workspace>:<pr>:<head>:` prefix). */
  hasPagedHead: (taskId: string, headPrefix: string) => Promise<boolean>;
  /** Atomic claim: true for exactly one caller per key. */
  claimKey: (taskId: string, key: string) => Promise<boolean>;
  send: (subject: { workspaceId: string; taskId: string }, payload: PagePayload) => Promise<void>;
  appUrl: () => string;
}

export function pageKey(i: { workspaceId: string; prNumber: number; headSha: string }, reason: PageReason): string {
  return `${headPrefix(i)}${reason}`;
}
const headPrefix = (i: { workspaceId: string; prNumber: number; headSha: string }) => `${i.workspaceId}:${i.prNumber}:${i.headSha}:`;

export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function reasonOf(outcome: LandingOutcome): PageReason | null {
  if (outcome.kind === 'needs_human') return UNPAGED_CAUSES.has(outcome.cause) ? null : `needs_human:${outcome.cause}`;
  if (outcome.kind === 'needs_fix') return `fix_stuck:${outcome.fix}`;
  return null;
}

export function plainReason(reason: PageReason): string {
  const [family, detail = ''] = reason.split(':');
  if (family === 'fix_stuck') return FIX_WORDS[detail as FixKind] ?? 'its fix was not picked up';
  if (family === 'needs_human') return CAUSE_WORDS[detail as HumanCause] ?? 'it needs a person';
  return 'landing has stopped making progress';
}

/**
 * What counts as landing progress, as one comparable string: the head landing
 * is working on (a refresh's new head, not the one it replaced), the coarse
 * stage, and the newest review round. Any of these changing restarts the
 * invariant clock. `updating_branch` and `waiting_ci` are one stage: both are
 * "this head is waiting on its checks", so flipping between them is not progress.
 */
export function progressFingerprint(outcome: LandingOutcome, headSha: string, reviewAt: number | null): string {
  const stage =
    outcome.kind === 'needs_fix' ? `fix:${outcome.fix}`
      : outcome.kind === 'needs_human' ? `human:${outcome.cause}`
        : 'waiting';
  return `${headSha}|${stage}|${reviewAt ?? ''}`;
}

/** The head an outcome is about: a refresh has moved on to the head it produced. */
const workingHead = (input: LandingAlertInput): string =>
  input.outcome.kind === 'updating_branch' && input.outcome.newHeadSha ? input.outcome.newHeadSha : input.headSha;

/** Live check state for the copy: only what landing observed on this head, never assumed green. */
function checksFor(input: LandingAlertInput): ChecksState | null {
  if (input.outcome.kind === 'needs_fix' && input.outcome.fix === 'ci_fix') return 'red';
  // A refresh pushed a new head: its checks have only just started.
  if (input.outcome.kind === 'updating_branch') return 'pending';
  return input.checks ?? null;
}

const CHECK_WORDS: Record<ChecksState, string> = { green: 'checks green', pending: 'checks pending', red: 'checks red' };

export function buildLandingPageCopy(i: {
  prNumber: number;
  prTitle: string | null;
  reason: PageReason;
  detail: string;
  approvedAgeMs?: number | null;
  stuckMs: number;
  checks?: ChecksState | null;
  /** Time since the last landing progress; shown when it differs from `stuckMs`. */
  quietMs?: number | null;
}): { title: string; message: string } {
  const checks = i.reason === 'fix_stuck:ci_fix' ? 'red' : (i.checks ?? null);
  const quiet = i.quietMs != null && i.quietMs >= 60_000 && formatDuration(i.quietMs) !== formatDuration(i.stuckMs) ? i.quietMs : null;
  const facts = [
    i.approvedAgeMs != null && i.approvedAgeMs >= 60_000 ? `Approved ${formatDuration(i.approvedAgeMs)} ago` : null,
    checks ? CHECK_WORDS[checks] : null,
    i.stuckMs >= 60_000 ? `stuck ${formatDuration(i.stuckMs)}` : null,
    quiet != null ? `no progress for ${formatDuration(quiet)}` : null,
  ].filter(Boolean);
  return {
    title: `PR #${i.prNumber} won't land: ${plainReason(i.reason)}`,
    message: [i.prTitle ?? `PR #${i.prNumber}`, facts.length ? `${facts.join(' · ')}.` : null, i.detail].filter(Boolean).join('\n'),
  };
}

/**
 * Pages at most once per key. Never throws: an alert must not be what fails a landing.
 * A failed send is not retried — the claim already happened, and a duplicate page
 * on a flaky channel is worse than a missed one that the invariant clock backs up.
 */
/** The PR's changed-files view on GitHub. */
export function githubFilesUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}/files`;
}

export async function alertOnLanding(input: LandingAlertInput, deps: LandingAlertDeps): Promise<void> {
  try {
    const { outcome, taskId } = input;
    if (!taskId || outcome.kind === 'merged') return;
    if (outcome.kind === 'needs_human' && UNPAGED_CAUSES.has(outcome.cause)) return;

    const nowMs = deps.now();
    const nowIso = new Date(nowMs).toISOString();
    const head = workingHead(input);
    const keyed = { ...input, headSha: head };
    const heldSince = Date.parse((await deps.observe(taskId, 'held', nowIso, true)) ?? nowIso);
    const stuckMs = Math.max(0, nowMs - (Number.isFinite(heldSince) ? heldSince : nowMs));
    const approvedAgeMs = input.approvedAt && Number.isFinite(Date.parse(input.approvedAt)) ? nowMs - Date.parse(input.approvedAt) : null;
    const reviewAt = deps.lastReviewAt ? await deps.lastReviewAt(input.workspaceId, input.prNumber).catch(() => null) : null;
    const progressSince = Date.parse(await deps.markProgress(taskId, progressFingerprint(outcome, head, reviewAt), nowIso));
    const quietMs = Math.max(0, nowMs - (Number.isFinite(progressSince) ? progressSince : nowMs));

    let reason = reasonOf(outcome);
    let detail = outcome.kind === 'needs_human' || outcome.kind === 'needs_fix' ? outcome.reason : '';
    let priority: 0 | 1 = 0;

    if (outcome.kind === 'needs_fix') {
      const since = Date.parse((await deps.observe(taskId, `fix:${head}`, nowIso, true)) ?? nowIso);
      if (nowMs - since < FIX_PICKUP_BOUND_MS) reason = null;
    }

    if (!reason) {
      // A progressing PR is never paged, however long it has been held overall.
      if (quietMs < INVARIANT_ALARM_MS) return;
      if (await deps.hasPagedHead(taskId, headPrefix(keyed))) return;
      reason = 'invariant';
      priority = 1;
      const waitingOn = input.outcomeReason?.trim().replace(/\.+$/, '');
      detail = `Nothing has moved on this commit for ${formatDuration(quietMs)}${waitingOn ? `. Last landing check: ${waitingOn}` : ''}.`;
    }

    // The decision is about `head`. If the PR moved since, this advice is stale:
    // the new head gets its own landing pass, and its own page if it earns one.
    if (deps.readLiveHead) {
      const live = await deps.readLiveHead(input).catch(() => null);
      if (live && live !== head) return;
    }

    if (!(await deps.claimKey(taskId, pageKey(keyed, reason)))) return;

    const plan = actionsForReason(reason);
    const copy = buildLandingPageCopy({
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      reason,
      detail,
      approvedAgeMs,
      stuckMs,
      checks: checksFor(input),
      quietMs: reason === 'invariant' ? quietMs : null,
    });
    const base = `${deps.appUrl().replace(/\/$/, '')}/app/prs/${input.prNumber}/act`;
    if (plan.primary === 'review_on_github') {
      // Nothing for buildd to run: one tap should open the diff itself.
      await deps.send(
        { workspaceId: input.workspaceId, taskId },
        { ...copy, url: githubFilesUrl(input.repoFullName, input.prNumber), urlTitle: LANDING_ACTION_LABELS.review_on_github, priority },
      );
      return;
    }
    const token = signLandingActionToken(
      { workspaceId: input.workspaceId, prNumber: input.prNumber, headSha: head, action: plan.primary, reason, taskId },
      nowMs,
    );
    await deps.send(
      { workspaceId: input.workspaceId, taskId },
      {
        ...copy,
        url: token ? `${base}?t=${encodeURIComponent(token)}` : base,
        urlTitle: LANDING_ACTION_LABELS[plan.primary],
        priority,
      },
    );
  } catch (err) {
    console.warn('[pr-landing-alert] alert failed:', err instanceof Error ? err.message : 'unknown');
  }
}
