// The owner's release flow on top of frozen candidates: Compose → Cut → Review
// → Release. Pure; the GitHub and database reads that feed it live in
// apps/web/src/lib/release/compose-source.ts.
//
// Compose lists what would ship, grouped by mission:
//   - on dev: a mission whose work already merged into the source branch since
//     the last release. Selected by default. Leaving it out is a deliberate
//     candidate amendment: its merge is reverted on the candidate branch, which
//     makes a new candidate SHA and voids every check and approval on the old one.
//   - ready: a mission whose mission PR is open, approved and green but not
//     merged. Unselected by default. Including it merges the mission PR into the
//     source branch through the normal gated merge path before the cut.
//   - other changes: PRs on dev that belong to no mission, each its own row.
//
// A release is never done on PR open or merge: only when production reports a
// deployed SHA that is (or descends from) the candidate's merge commit.

/** One check's state, as the page shows it. */
export type ComposeCheckState = 'passing' | 'failing' | 'pending' | 'missing';

/** A whole set of checks, summarised. `none` = nothing reported. */
export type ComposeChecksSummary = 'passing' | 'failing' | 'pending' | 'none';

export interface ComposePr {
  number: number;
  title: string;
  url: string;
  /** The commit that put this PR on the source branch; what an exclusion reverts. */
  mergeSha: string | null;
  missionId: string | null;
}

export interface ComposeCriteria {
  met: number;
  total: number;
}

export interface ComposeMissionPr {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  /** Open PRs only: an approving review stands on its current head. */
  approved: boolean;
  checks: ComposeChecksSummary;
}

export interface ComposeMission {
  id: string;
  title: string;
  criteria: ComposeCriteria | null;
  missionPr: ComposeMissionPr | null;
}

export interface CompositionInput {
  /** PRs merged into the source branch since the last release, newest first. */
  shippedPrs: ComposePr[];
  /** Every mission referenced by a shipped PR, plus missions with an open mission PR. */
  missions: ComposeMission[];
}

export type ComposeKey = `mission:${string}` | `pr:${number}`;

export interface MissionGroup {
  key: ComposeKey;
  kind: 'on_dev' | 'ready';
  mission: ComposeMission;
  /** on_dev: the mission's PRs on the source branch. ready: its open mission PR. */
  prs: ComposePr[];
}

export interface OtherChange {
  key: ComposeKey;
  pr: ComposePr;
}

export interface Composition {
  onDev: MissionGroup[];
  ready: MissionGroup[];
  /** Open mission PRs that are not yet approved and green; listed, never selectable. */
  notReady: MissionGroup[];
  other: OtherChange[];
}

export const missionKey = (id: string): ComposeKey => `mission:${id}`;
export const prKey = (n: number): ComposeKey => `pr:${n}`;

/** True when a mission PR may be included: open, approved, and every check passing. */
export function isMissionPrReady(pr: ComposeMissionPr | null): boolean {
  return !!pr && pr.state === 'open' && pr.approved && pr.checks === 'passing';
}

export function groupComposition(input: CompositionInput): Composition {
  const missionsById = new Map(input.missions.map((m) => [m.id, m]));
  const byMission = new Map<string, ComposePr[]>();
  const other: OtherChange[] = [];
  for (const pr of input.shippedPrs) {
    const mission = pr.missionId ? missionsById.get(pr.missionId) : undefined;
    if (!mission) {
      other.push({ key: prKey(pr.number), pr });
      continue;
    }
    const list = byMission.get(mission.id) ?? [];
    list.push(pr);
    byMission.set(mission.id, list);
  }

  const onDev: MissionGroup[] = [];
  for (const [id, prs] of byMission) {
    onDev.push({ key: missionKey(id), kind: 'on_dev', mission: missionsById.get(id)!, prs });
  }

  const ready: MissionGroup[] = [];
  const notReady: MissionGroup[] = [];
  for (const mission of input.missions) {
    if (byMission.has(mission.id)) continue;
    const pr = mission.missionPr;
    if (!pr || pr.state !== 'open') continue;
    const group: MissionGroup = {
      key: missionKey(mission.id),
      kind: 'ready',
      mission,
      prs: [{ number: pr.number, title: pr.title, url: pr.url, mergeSha: null, missionId: mission.id }],
    };
    (isMissionPrReady(pr) ? ready : notReady).push(group);
  }
  return { onDev, ready, notReady, other };
}

/** Everything on dev is in; ready missions are out until the owner picks them. */
export function defaultSelection(c: Composition): Set<ComposeKey> {
  return new Set<ComposeKey>([...c.onDev.map((g) => g.key), ...c.other.map((o) => o.key)]);
}

export interface Exclusion {
  key: ComposeKey;
  label: string;
  /** Commits to revert on the candidate, newest first. */
  shas: string[];
}

export interface CompositionPlan {
  /** Ready missions to merge into the source branch before the cut. */
  merges: Array<{ missionId: string; title: string; prNumber: number }>;
  /** Changes already on dev to revert on the candidate. */
  exclusions: Exclusion[];
  missionCount: number;
  otherCount: number;
  /** Keys that cannot be selected: not in the composition (a stale page) or a mission PR that is not ready. */
  unknown: string[];
  /** An on-dev change with no merge commit to revert: it cannot be excluded. */
  unrevertable: string[];
}

export function planComposition(c: Composition, selected: Iterable<string>): CompositionPlan {
  const sel = new Set(selected);
  const known = new Set<string>([...c.onDev, ...c.ready, ...c.notReady].map((g) => g.key).concat(c.other.map((o) => o.key)));
  const unknown = [...sel].filter((k) => !known.has(k));
  const notReadyPicked = c.notReady.filter((g) => sel.has(g.key)).map((g) => g.key);

  const merges = c.ready
    .filter((g) => sel.has(g.key))
    .map((g) => ({ missionId: g.mission.id, title: g.mission.title, prNumber: g.prs[0].number }));

  const exclusions: Exclusion[] = [];
  const unrevertable: string[] = [];
  for (const g of c.onDev) {
    if (sel.has(g.key)) continue;
    const shas = g.prs.map((p) => p.mergeSha);
    if (shas.some((s) => !s)) unrevertable.push(g.key);
    exclusions.push({ key: g.key, label: g.mission.title, shas: shas.filter((s): s is string => !!s) });
  }
  for (const o of c.other) {
    if (sel.has(o.key)) continue;
    if (!o.pr.mergeSha) unrevertable.push(o.key);
    exclusions.push({ key: o.key, label: `#${o.pr.number} ${o.pr.title}`, shas: o.pr.mergeSha ? [o.pr.mergeSha] : [] });
  }

  return {
    merges,
    exclusions,
    missionCount: c.onDev.filter((g) => sel.has(g.key)).length + merges.length,
    otherCount: c.other.filter((o) => sel.has(o.key)).length,
    unknown: [...unknown, ...notReadyPicked],
    unrevertable,
  };
}

/**
 * What the owner reads before confirming an exclusion. Plain about the cost:
 * the candidate SHA changes and nothing verified on the old one counts.
 */
export function exclusionNotice(exclusions: Exclusion[], candidateSha: string | null): string | null {
  if (exclusions.length === 0) return null;
  const names = exclusions.map((e) => e.label).join(', ');
  const what = exclusions.length === 1 ? 'its merge' : 'their merges';
  const head = `Leaving out ${names} reverts ${what} on the candidate branch.`;
  return candidateSha
    ? `${head} That makes a new candidate SHA: every check and approval on ${candidateSha.slice(0, 9)} is void, and CI and review run again. dev keeps the work for the next release.`
    : `${head} The candidate is cut from dev and then amended, so it gets a new SHA before anything is verified. dev keeps the work for the next release.`;
}

// ── Review ──────────────────────────────────────────────────────────────────

/**
 * The checks a candidate must pass on its exact SHA, by check-run name. Same
 * list the release workflow writes into the candidate PR's "Required before
 * merge" (scripts/release-candidate.ts); a test pins the two together.
 */
export const REQUIRED_CANDIDATE_CHECKS = ['build', 'release candidate verified', 'Schema Drift / check-prod'] as const;

export interface CandidateCheck {
  name: string;
  /** The commit the check ran on. A check on another SHA is not evidence for this one. */
  sha: string;
  state: Exclude<ComposeCheckState, 'missing'>;
  url: string | null;
}

export interface CandidateReview {
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  /** The commit the review was submitted on. */
  sha: string;
}

export interface CandidateVerdict {
  checks: Array<{ name: string; state: ComposeCheckState; url: string | null; required: boolean }>;
  allChecksPassed: boolean;
  approved: boolean;
  /** Approvals left on an earlier candidate SHA (void after an amendment). */
  staleApprovals: number;
  readyToRelease: boolean;
}

/**
 * Per-check status of the candidate, counted on its exact SHA only. Required
 * checks with no run on that SHA are `missing`; checks and approvals on an
 * earlier candidate SHA count for nothing.
 */
export function candidateVerdict(input: {
  candidateSha: string;
  required: readonly string[];
  checks: CandidateCheck[];
  reviews: CandidateReview[];
}): CandidateVerdict {
  const onSha = input.checks.filter((c) => c.sha === input.candidateSha);
  const byName = new Map<string, CandidateCheck>();
  for (const c of onSha) byName.set(c.name, c);
  const rows: CandidateVerdict['checks'] = input.required.map((name) => {
    const c = byName.get(name);
    return { name, state: c ? c.state : 'missing', url: c?.url ?? null, required: true };
  });
  for (const c of onSha) {
    if (!input.required.includes(c.name)) rows.push({ name: c.name, state: c.state, url: c.url, required: false });
  }
  const allChecksPassed = rows.every((r) => r.state === 'passing');
  const approvals = input.reviews.filter((r) => r.state === 'APPROVED');
  const blocking = input.reviews.some((r) => r.state === 'CHANGES_REQUESTED' && r.sha === input.candidateSha);
  const approved = !blocking && approvals.some((r) => r.sha === input.candidateSha);
  return {
    checks: rows,
    allChecksPassed,
    approved,
    staleApprovals: approvals.filter((r) => r.sha !== input.candidateSha).length,
    readyToRelease: allChecksPassed && approved,
  };
}

// ── Release ─────────────────────────────────────────────────────────────────

export type ProductionState = 'not_merged' | 'awaiting_production' | 'released';

/**
 * Released means production runs the candidate's merge commit or something
 * after it. A merged PR alone is `awaiting_production`; an unknown deployed
 * SHA, or one that does not contain the merge, never reads as released.
 */
export function productionState(input: {
  mergeSha: string | null;
  deployedSha: string | null;
  /** Whether deployedSha contains mergeSha (GitHub compare: ahead or identical); null = unknown. */
  deployedContainsMerge: boolean | null;
}): ProductionState {
  if (!input.mergeSha) return 'not_merged';
  if (!input.deployedSha) return 'awaiting_production';
  if (input.deployedSha === input.mergeSha) return 'released';
  return input.deployedContainsMerge === true ? 'released' : 'awaiting_production';
}

export type FlowStep = 'compose' | 'review' | 'release' | 'released';

export function flowStep(input: { hasCandidate: boolean; production: ProductionState }): FlowStep {
  if (input.production === 'released') return 'released';
  if (input.production === 'awaiting_production') return 'release';
  return input.hasCandidate ? 'review' : 'compose';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function compositionCounts(missions: number, other: number): string {
  return `${plural(missions, 'mission')}, ${plural(other, 'other change')}`;
}

/** The page's first sentence: the result, then what it holds. */
export function releaseLede(input: {
  version: string | null;
  step: FlowStep;
  /** Omitted when unknown (a candidate merged outside this flow): the sentence then drops the counts. */
  missions?: number;
  other?: number;
  verdict?: Pick<CandidateVerdict, 'checks' | 'allChecksPassed' | 'approved'> | null;
}): string {
  const v = input.version ? `v${input.version.replace(/^v/, '')}` : 'The next release';
  const known = input.missions !== undefined && input.other !== undefined;
  const counts = known ? compositionCounts(input.missions!, input.other!) : '';
  const tail = known ? `: ${counts}.` : '.';
  switch (input.step) {
    case 'released':
      return `${v} is in production${tail}`;
    case 'release':
      return `${v} is merged and waiting for production to run it${tail}`;
    case 'review': {
      const vd = input.verdict;
      if (!vd) return `${v} is cut: ${counts}. Checks have not reported.`;
      const failing = vd.checks.filter((c) => c.state === 'failing').length;
      const waiting = vd.checks.filter((c) => c.state === 'pending' || c.state === 'missing').length;
      if (vd.allChecksPassed && vd.approved) return `${v} is ready to release: ${counts}, all checks passed.`;
      if (failing > 0) return `${v} is not ready: ${counts}, ${plural(failing, 'check')} failing.`;
      if (waiting > 0) return `${v} is not ready: ${counts}, ${plural(waiting, 'check')} still running.`;
      return `${v} is not ready: ${counts}, all checks passed, no approval on this SHA.`;
    }
    default:
      return `${v} would ship ${counts}.`;
  }
}
