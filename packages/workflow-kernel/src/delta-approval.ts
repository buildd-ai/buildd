/**
 * Delta approval and review-round triggers (task 58c8961e).
 *
 * An approval at head A, plus a passing diff-only review of A..B, is an
 * approval at B. The merge door's question does not change ("does an approval
 * cover the exact head being merged?"): the delta round's own approve puts B in
 * `approved_heads`, exactly as a full round would. What this module decides is
 * only whether the round that follows an approval may be a delta round at all.
 *
 * It may only when every one of these holds, and the answer is a full review
 * otherwise (unread, unknown or borderline is always full):
 *
 *  - the last decided round approved, the delivery's approval is a reviewer
 *    verdict (not a person's, a policy's or a composition's) and it covers
 *    both that round's head and the head the delta is read from;
 *  - no finding is still open (an open changes-requested point is reviewed in
 *    full, never waved through on a delta);
 *  - the host read the delta (A..B, bounded against the base) and the read is
 *    complete;
 *  - every file the delta touches was already in the PR at A, or is a test or
 *    test-config file being added or modified (a deletion of a file the PR did
 *    not already touch is never a delta);
 *  - the delta is small: at most `DELTA_MAX_FILES` files and
 *    `DELTA_MAX_LINES` added plus deleted lines.
 *
 * The kernel owns the rule; the host only reads GitHub (no buildd paths here).
 */
import type { DeliverySnapshot, KernelView, RoundSnapshot } from './types';
import { openFindings } from './findings';

/**
 * Why a review round started. `superseded_by_push` is a round started by a
 * push while an earlier round at another head was still open; the round it
 * replaced ends `superseded` with the same reason, never with no verdict.
 * `verify_findings` and `composition` are the kernel's own same-head rounds.
 */
export type RoundTrigger =
  | 'first_pass'
  | 'changes_requested_fix'
  | 'ci_fix'
  | 'new_commits'
  | 'base_refresh'
  | 'manual_force'
  | 'superseded_by_push'
  | 'verify_findings'
  | 'composition';

export const ROUND_TRIGGERS: readonly RoundTrigger[] = [
  'first_pass', 'changes_requested_fix', 'ci_fix', 'new_commits', 'base_refresh', 'manual_force', 'superseded_by_push', 'verify_findings', 'composition',
];

/** Plain words for a trigger, for the activity comment and explain. */
export const ROUND_TRIGGER_COPY: Record<RoundTrigger, string> = {
  first_pass: 'first review',
  changes_requested_fix: 'after a fix for requested changes',
  ci_fix: 'after a CI fix',
  new_commits: 'after new commits',
  base_refresh: 'after the base branch was merged in',
  manual_force: 'asked for by a person',
  superseded_by_push: 'a newer push replaced the open review',
  verify_findings: 'to verify open findings',
  composition: 'changes new to a composed PR',
};

export function isRoundTrigger(v: unknown): v is RoundTrigger {
  return typeof v === 'string' && (ROUND_TRIGGERS as readonly string[]).includes(v);
}

/** Triggers that mean "the PR's head moved": the rounds they replace were superseded by a push. */
export const PUSH_TRIGGERS: ReadonlySet<RoundTrigger> = new Set<RoundTrigger>(['changes_requested_fix', 'ci_fix', 'new_commits', 'base_refresh', 'superseded_by_push']);

/** One file of a delta read: the change between the approved head and the new one. */
export interface DeltaFile {
  path: string;
  /** The file's name at A, when the delta renamed it. */
  previousPath?: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged' | string;
  additions: number;
  deletions: number;
}

/**
 * The host's read of a delta, A..B, bounded against the PR's base so a file
 * the base moved on its own never appears. `prFilesAtFrom` is the PR's own file
 * list at A. Absent or null means unread, and an unread delta is a full review.
 */
export interface DeltaReading {
  fromHeadSha: string;
  toHeadSha: string;
  prFilesAtFrom: string[];
  files: DeltaFile[];
}

export const DELTA_MAX_FILES = 10;
export const DELTA_MAX_LINES = 200;

const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?|spec|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const TEST_CONFIG_PATH = /(^|\/)(vitest|jest|playwright|bunfig|tsconfig)[^/]*\.(json|toml|[cm]?[jt]s)$/;

/** A test, a test fixture or a test runner's config. Package manifests, lockfiles, CI and migrations are not. */
export function isTestOrConfigPath(path: string): boolean {
  return TEST_PATH.test(path) || TEST_CONFIG_PATH.test(path);
}

export interface DeltaEligibility {
  eligible: boolean;
  /** Why, in a short phrase: recorded on the round and shown when the review is full. */
  reason: string;
  fromHeadSha: string | null;
  files?: number;
  lines?: number;
}

/**
 * The approved head a delta read should start from, when the round after this
 * view's approval could be a delta review at all; null when it never could (the
 * host then reads nothing). The newest approved head: a content-equivalent
 * carry appends to `approved_heads`, so the newest one is closest to the push.
 */
export function deltaApprovalSource(view: Pick<KernelView, 'delivery' | 'rounds'>): string | null {
  const d = view.delivery;
  if (!d || d.approvalBasis !== 'verdict' || d.approvedHeads.length === 0) return null;
  const last = lastDecided(view.rounds);
  if (!last || last.effectiveVerdict !== 'approve' || !d.approvedHeads.includes(last.headSha)) return null;
  return d.approvedHeads.at(-1) ?? null;
}

function lastDecided(rounds: RoundSnapshot[]): RoundSnapshot | undefined {
  return rounds.filter((r) => r.status === 'decided').sort((a, b) => b.round - a.round)[0];
}

/**
 * May the round at `head` be a delta review of `reading`, carrying the
 * approval it follows? Pure; see the module comment for every condition.
 */
export function deltaApprovalEligibility(
  view: Pick<KernelView, 'delivery' | 'rounds' | 'findings'>,
  head: string,
  reading: DeltaReading | null | undefined,
): DeltaEligibility {
  const d = view.delivery as DeliverySnapshot | null;
  const no = (reason: string, fromHeadSha: string | null = null, extra: Partial<DeltaEligibility> = {}): DeltaEligibility => ({ eligible: false, reason, fromHeadSha, ...extra });
  if (!d) return no('no delivery');
  const last = lastDecided(view.rounds);
  if (!last || last.effectiveVerdict !== 'approve') return no('the last review did not approve');
  if (last.scope?.composition === true) return no('the approval covers a composed PR');
  if (d.approvalBasis !== 'verdict') return no('the approval is not a reviewer verdict');
  if (!d.approvedHeads.includes(last.headSha)) return no('the last approval no longer covers its own head');
  if (openFindings(view).length > 0) return no('a requested change is still open');
  if (!reading) return no('the delta could not be read');
  const from = reading.fromHeadSha;
  if (reading.toHeadSha !== head) return no('the delta read is for another head', from);
  if (!d.approvedHeads.includes(from)) return no('the delta does not start at an approved head', from);
  if (from === head) return no('the delta is empty', from);
  const inPr = new Set(reading.prFilesAtFrom);
  let lines = 0;
  for (const f of reading.files) {
    const add = Number.isFinite(f.additions) ? Math.max(0, f.additions) : Infinity;
    const del = Number.isFinite(f.deletions) ? Math.max(0, f.deletions) : Infinity;
    lines += add + del;
    const names = [f.path, ...(f.previousPath && f.previousPath !== f.path ? [f.previousPath] : [])];
    for (const name of names) {
      if (inPr.has(name)) continue;
      if (f.status !== 'removed' && isTestOrConfigPath(name)) continue;
      return no(`the delta touches a file outside the PR (${name})`, from);
    }
  }
  const files = reading.files.length;
  if (files > DELTA_MAX_FILES) return no(`the delta touches ${files} files, over the cap of ${DELTA_MAX_FILES}`, from, { files, lines });
  if (!(lines <= DELTA_MAX_LINES)) return no(`the delta changes ${Number.isFinite(lines) ? lines : 'an unknown number of'} lines, over the cap of ${DELTA_MAX_LINES}`, from, { files, lines });
  return { eligible: true, reason: 'small delta inside the approved PR', fromHeadSha: from, files, lines };
}
