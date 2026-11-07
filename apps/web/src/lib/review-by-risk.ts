/**
 * Review by risk (spec 62e985a8 "Review by risk", revision 2).
 *
 * A mode of the workspace merge policy (`gitConfig.mergePolicy.reviewByRisk`),
 * off unless a person turns it on. While on:
 *
 *  - R-1: a worker PR into the workspace's integration branch merges on its own
 *    when CI is green, it has no conflict, its review did not request changes
 *    and, when pinned to a spec revision, every AC-n it answers for has a test
 *    named with that id that passed at the PR head. The integration branch is
 *    `resolveTaskPrBase`'s answer for the workspace (no mission, no task), never
 *    a hard-coded `dev`.
 *  - R-4/R-5: a PR touching a listed Access, Credentials or Data migrations
 *    path, or an acceptance test (found by AC id and `check:` line), waits for a
 *    person. A person's own merge is that approval.
 *  - R-10: nothing here relaxes CI, the review verdict, host branch protection
 *    or the merge method: those rails keep running where they always ran.
 *
 * Pure. The rail that reads GitHub and the spec verdicts is
 * `evaluateAutoMergeSafety` (auto-merge.ts), the one check every merge door and
 * the workflow kernel's merge rails already call, so no door gets an inline
 * copy. The release half (R-6, R-7) is lib/release/summary.ts.
 */

import {
  reviewByRiskOf,
  REVIEW_BY_RISK_PATH_AREAS,
  type ReviewByRiskArea,
  type ReviewByRiskPolicy,
} from '@buildd/shared';
import { isMissionIntegrationBase, resolveTaskPrBase, type MissionIntegrationFields } from '@buildd/core/mission-integration';
import { isAcceptanceTestPath } from '@buildd/spec-contract/acceptance-edit';
export { REVIEW_BY_RISK_AREA_LABEL, REVIEW_BY_RISK_AREA_WHAT, emptyRiskAreas, applyReviewByRiskWrite } from '@/lib/review-by-risk-config';
import { REVIEW_BY_RISK_AREA_LABEL } from '@/lib/review-by-risk-config';

type GitConfigLike = { mergePolicy?: unknown; targetBranch?: string | null; defaultBranch?: string | null } | null | undefined;

/**
 * The workspace's integration branch: where a worker PR outside a mission
 * lands, from the same resolver `create_pr` uses (no mission, no task, so its
 * workspace fallbacks decide). Null when the workspace names none.
 */
export function workspaceIntegrationBranch(gitConfig: GitConfigLike, repoDefaultBranch?: string | null): string | null {
  return resolveTaskPrBase({
    fallbacks: [gitConfig?.targetBranch, gitConfig?.defaultBranch, repoDefaultBranch],
  }).base;
}

export interface ReviewByRiskApplies {
  policy: ReviewByRiskPolicy;
  integrationBranch: string;
}

/**
 * Does review by risk govern a PR with this base? Only when the workspace has
 * it on and the base is the workspace's integration branch. A mission's own
 * integration branch keeps its own rules (out of scope), and so does any other
 * base, a release PR into production included.
 */
export function reviewByRiskFor(args: {
  gitConfig: GitConfigLike;
  baseRef: string | null | undefined;
  mission?: MissionIntegrationFields | null;
  repoDefaultBranch?: string | null;
}): ReviewByRiskApplies | null {
  const policy = reviewByRiskOf(args.gitConfig?.mergePolicy);
  if (!policy || !args.baseRef) return null;
  if (isMissionIntegrationBase({ baseRef: args.baseRef, mission: args.mission ?? null })) return null;
  const integrationBranch = workspaceIntegrationBranch(args.gitConfig, args.repoDefaultBranch);
  if (!integrationBranch || integrationBranch !== args.baseRef) return null;
  return { policy, integrationBranch };
}

// ── R-4/R-5: risk areas ──────────────────────────────────────────────────────

export interface PrFileDiff {
  filename: string;
  /** The file's name before a rename; both sides count. */
  previous_filename?: string | null;
  status?: string | null;
  /** GitHub's unified diff for the file; absent for binary or very large diffs. */
  patch?: string | null;
}

export interface RiskAreaHit {
  area: ReviewByRiskArea;
  /** The changed file. */
  file: string;
  /** What matched: the listed path, an AC id, or `check:`. */
  matched: string;
}

/** A listed path matches a file: `dir/` and `prefix*` are prefixes, anything else the file itself or a directory under it. */
export function pathMatches(listed: string, file: string): boolean {
  const p = listed.trim();
  if (!p) return false;
  if (p.endsWith('*')) return file.startsWith(p.slice(0, -1));
  if (p.endsWith('/')) return file.startsWith(p);
  return file === p || file.startsWith(`${p}/`);
}

const TEST_FILE = /(^|\/)(__tests__\/|tests?\/)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|ts|js)$|(^|\/)test_[^/]+\.py$/i;
/** A test file, by the usual names and directories. */
export const isTestPath = (path: string): boolean => TEST_FILE.test(path);

const AC_ID = /(?<![A-Za-z0-9-])AC-\d+[a-z]?(?![A-Za-z0-9-])/g;
/** A test declaration in a diff line: `test(`, `it(`, `describe(` (any modifier), `def test_`, `func Test`. */
const TEST_DECL = /\b(?:test|it|describe|context|scenario)(?:\.\w+)*\s*\(|\bdef\s+test_|\bfunc\s+Test/;
/** A spec `check:` line, as a criterion carries it. */
const CHECK_LINE = /^\s*(?:[-*]\s+)?check:\s*\S/;

function changedLines(patch: string): string[] {
  return patch.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).map((l) => l.slice(1));
}

/**
 * The acceptance-test hits of one file. A test file whose added or removed
 * lines declare a test named with an AC id, a file named as an acceptance test
 * (`isAcceptanceTestPath`), or any file whose diff adds or removes a `check:`
 * line. A test file with no readable diff cannot be shown clean, so it holds.
 */
function acceptanceTestHits(f: PrFileDiff): RiskAreaHit[] {
  const hits: RiskAreaHit[] = [];
  const names = [f.filename, f.previous_filename].filter((n): n is string => !!n);
  if (names.some(isAcceptanceTestPath)) hits.push({ area: 'acceptanceTests', file: f.filename, matched: 'acceptance test file' });
  if (typeof f.patch !== 'string') {
    if (!hits.length && names.some(isTestPath) && f.status !== 'renamed') {
      hits.push({ area: 'acceptanceTests', file: f.filename, matched: 'test file with no readable diff' });
    }
    return hits;
  }
  const lines = changedLines(f.patch);
  if (names.some(isTestPath)) {
    const ids = new Set<string>();
    for (const l of lines) if (TEST_DECL.test(l)) for (const m of l.match(AC_ID) ?? []) ids.add(m);
    for (const id of ids) hits.push({ area: 'acceptanceTests', file: f.filename, matched: id });
  }
  if (lines.some((l) => CHECK_LINE.test(l))) hits.push({ area: 'acceptanceTests', file: f.filename, matched: 'check: line' });
  return hits;
}

/** Every R-4 area this PR touches, in area order, each file once per area. */
export function matchRiskAreas(files: readonly PrFileDiff[], policy: ReviewByRiskPolicy): RiskAreaHit[] {
  const hits: RiskAreaHit[] = [];
  for (const area of REVIEW_BY_RISK_PATH_AREAS) {
    const listed = (policy.areas?.[area] ?? []).filter((p) => p.trim());
    if (!listed.length) continue;
    for (const f of files) {
      const names = [f.filename, f.previous_filename].filter((n): n is string => !!n);
      const path = listed.find((p) => names.some((n) => pathMatches(p, n)));
      if (path) hits.push({ area, file: f.filename, matched: path });
    }
  }
  for (const f of files) hits.push(...acceptanceTestHits(f));
  return hits;
}

// ── R-1: acceptance checks tested at the head ───────────────────────────────

/** One AC's standing at the PR head, as the governed-outcome fold reports it. */
export interface AcStanding {
  criterionId: string;
  verdict: string | null;
  /** `test` when a criterion check run (a test) decided it. */
  source: string | null;
  headSha: string | null;
}

const sameHead = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return false;
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * The AC ids with no test named with that id that passed at `headSha`. A
 * test's result is recorded per criterion by its check run (source `test`);
 * a reviewer's pass is not a test, and a pass on an older head does not count.
 */
export function untestedAcceptanceChecks(acIds: readonly string[], standings: readonly AcStanding[], headSha: string): string[] {
  const by = new Map(standings.map((s) => [s.criterionId, s]));
  return acIds.filter((id) => {
    const s = by.get(id);
    return !(s && s.verdict === 'pass' && s.source === 'test' && sameHead(s.headSha, headSha));
  });
}

// ── The decision ────────────────────────────────────────────────────────────

/** Refusal prefixes `classifyAutoMergeRefusal` keys on. */
export const RISK_HOLD_PREFIX = 'review by risk: waits for a person';
export const AC_UNTESTED_PREFIX = 'review by risk: no passing acceptance test';

export function isRiskHoldReason(reason: string): boolean {
  return reason.startsWith(RISK_HOLD_PREFIX);
}
export function isAcUntestedReason(reason: string): boolean {
  return reason.startsWith(AC_UNTESTED_PREFIX);
}

export function riskHoldReason(hits: readonly RiskAreaHit[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const key = `${h.area}\0${h.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${REVIEW_BY_RISK_AREA_LABEL[h.area]}: ${h.file} (${h.matched})`);
  }
  const shown = parts.slice(0, 5);
  const more = parts.length > shown.length ? `; and ${parts.length - shown.length} more` : '';
  return `${RISK_HOLD_PREFIX} to approve it — ${shown.join('; ')}${more}`;
}

export function acUntestedReason(untested: readonly string[], headSha: string): string {
  const noun = untested.length === 1 ? 'check has' : 'checks have';
  return `${AC_UNTESTED_PREFIX} at ${headSha.slice(0, 7)} — ${untested.join(', ')}: this ${noun} no test named with its id that passed at the PR head`;
}

export type RiskDecision =
  | { hold: false; hits: RiskAreaHit[] }
  | { hold: true; kind: 'risk_area'; reason: string; hits: RiskAreaHit[] }
  | { hold: true; kind: 'ac_untested'; reason: string; untested: string[]; hits: RiskAreaHit[] };

/**
 * The review-by-risk rail for one PR at one head. `person` is a person's own
 * merge: that is the approval R-4 asks for, and R-1 governs only merges with
 * nobody involved, so neither holds it. `acIds` is null for an unpinned PR
 * (R-3: no test condition).
 */
export function decideReviewByRisk(input: {
  policy: ReviewByRiskPolicy;
  files: readonly PrFileDiff[];
  headSha: string;
  acIds: readonly string[] | null;
  standings: readonly AcStanding[];
  person?: boolean;
}): RiskDecision {
  const hits = matchRiskAreas(input.files, input.policy);
  if (input.person) return { hold: false, hits };
  if (hits.length) return { hold: true, kind: 'risk_area', reason: riskHoldReason(hits), hits };
  if (input.acIds && input.acIds.length) {
    const untested = untestedAcceptanceChecks(input.acIds, input.standings, input.headSha);
    if (untested.length) return { hold: true, kind: 'ac_untested', reason: acUntestedReason(untested, input.headSha), untested, hits };
  }
  return { hold: false, hits };
}

