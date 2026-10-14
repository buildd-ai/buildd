// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The mission's checks after (and around) the build, as data (spec f7f67f1a
 * R-11 to R-24). A projection over facts other modules own: the visual review
 * state (`presentVisualReview`), the goal criteria state, the mission PR and
 * the release status (P-3). It stores nothing and decides nothing; when a
 * source disagrees with the page, the source wins.
 *
 * Only checks that apply become rows (R-15): visual review when a review
 * state exists, one row per goal criterion, the mission PR on a mission-branch
 * mission, the release when one is configured. There is no fixed checklist.
 */
import type { GoalCriteriaState, GoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import { presentVisualReview } from './workflow/visual-review-presentation';
import type { MissionVisualReviewState } from './workflow/visual-review-state';
import type { MissionIntegrationPrView } from './mission-integration-pr';
import type { MissionReleaseStatus } from './mission-delivery';

/** R-17's statuses. Only `passed` reads as passed; waived and not applicable never do. */
export type CheckStatus = 'queued' | 'running' | 'passed' | 'finding' | 'unable' | 'owner' | 'stale' | 'waived' | 'not_applicable';
export type CheckKind = 'visual' | 'criterion' | 'mission_pr' | 'release';
/** Who acts next on the row. `reviewer` is the review agent, `owner` a person. */
export type CheckActor = 'system' | 'reviewer' | 'owner' | 'none';

export interface CheckRepair { id: string; title: string; done: boolean }

export interface CheckRow {
  key: string;
  kind: CheckKind;
  label: string;
  /** What the row holds up: `blocks merge`, `goal`, `advisory`. Null when the label says it. */
  chip: string | null;
  blocks: boolean;
  status: CheckStatus;
  /** The status in a few words, for the row's right edge. */
  state: string;
  detail: string | null;
  /** The branch the check judged, when known. */
  target: string | null;
  /** The short commit the check judged, when known. */
  commit: string | null;
  actor: CheckActor;
  /** `product`: the screens or the work have a problem. `system`: the check itself failed. */
  problem: 'product' | 'system' | null;
  findings: { issues: number; fixesOpen: number } | null;
  /** Repair tasks shown inside the check (R-14), never in the build count. */
  repairs: CheckRepair[];
  evidence: { label: string; href: string }[];
}

export type RailKey = 'build' | 'verify' | 'deliver';
/** `part`: some of it passed and the rest waits on a later checkpoint. `held`: stopped until someone acts. */
export type RailState = 'done' | 'now' | 'part' | 'held' | 'todo';
export interface RailStep { key: RailKey; label: string; state: RailState; text: string }

export interface MissionChecks {
  rows: CheckRow[];
  rail: RailStep[];
  buildComplete: boolean;
  /** R-22: merged into the target, and healthy when a release is configured. */
  delivered: boolean;
  /** The checkpoint the mission waits on, or `done`. */
  checkpoint: RailKey | 'done';
}

export type MergeTier = 'auto-threshold' | 'agent-review' | 'human';

export interface MissionChecksInput {
  /** Build tasks only (P-2): repair, verification and maintenance never count. */
  build: { done: number; total: number };
  branch: 'mission-branch' | 'direct';
  /** The trunk the mission delivers into, e.g. `dev`. */
  target: string | null;
  mergeTier: MergeTier;
  visual: MissionVisualReviewState | null;
  repairs?: readonly CheckRepair[];
  criteria: readonly GoalCriterion[];
  criteriaState: GoalCriteriaState | null;
  integrationPr: MissionIntegrationPrView | null;
  release: MissionReleaseStatus;
  releaseLabel?: string | null;
  /** Links to existing evidence, by row key. */
  evidence?: Readonly<Record<string, readonly { label: string; href: string }[]>>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);
const sentence = (...parts: (string | null | undefined)[]) => {
  const s = parts.filter(Boolean).map(p => (/[.!?]$/.test(p!) ? p! : `${p}.`)).join(' ');
  return s || null;
};

const SETTLED: ReadonlySet<CheckStatus> = new Set(['passed', 'waived', 'not_applicable']);
const EARLY: ReadonlySet<CheckStatus> = new Set(['running', 'finding', 'owner', 'stale']);

// ── Visual review (R-17, R-18) ───────────────────────────────────────────────

/**
 * The visual review row, from `presentVisualReview`. Advisory unless it holds
 * up the merge or the finish. A pass on an older commit is stale, never passed.
 */
export function visualCheck(state: MissionVisualReviewState, opts: { mergeTier: MergeTier; repairs?: readonly CheckRepair[]; evidence?: readonly { label: string; href: string }[] }): CheckRow {
  const p = presentVisualReview(state, { ownerMergesIntegration: opts.mergeTier === 'human' });
  const blocks = state.blocksMerge || state.blocksCompletion;
  const base = {
    key: 'visual', kind: 'visual' as const, label: 'Visual review',
    chip: state.blocksMerge ? 'blocks merge' : blocks ? 'blocks finish' : 'advisory',
    blocks, target: state.branch.base, commit: short(state.branch.headSha),
    problem: p.problem, findings: p.findings, repairs: [...(opts.repairs ?? [])], evidence: [...(opts.evidence ?? [])],
  };
  const actor: CheckActor = p.needsYou ? 'owner' : state.nextActor === 'jev' ? 'reviewer' : state.nextActor === 'none' ? 'none' : 'system';
  const row = (status: CheckStatus, text: string, detail: string | null, who: CheckActor = actor): CheckRow => ({ ...base, status, state: text, detail, actor: who });

  if (state.status === 'waived') return row('waived', 'waived', p.detail, 'none');
  if (state.status === 'not_applicable') return row('not_applicable', 'not needed', 'No screens changed, so there was nothing to check.', 'none');
  if (state.status === 'optional' || state.policy.mode === 'off') return row('not_applicable', 'optional', 'Visual review is off for this mission.', 'none');
  if (state.status === 'passed') {
    if (state.staleEvidence) return row('stale', 'out of date', 'The branch changed after the last pass. It checks again.', 'system');
    return row('passed', 'passed', p.record?.detail ?? p.detail, 'none');
  }
  if (state.status === 'blocked') {
    return row(p.needsYou ? 'owner' : 'unable', p.needsYou ? 'waiting on you' : 'unable to run', sentence(p.label, p.detail));
  }
  if (state.status === 'findings' && state.findings) {
    if (p.needsYou) return row('owner', 'your call', sentence(p.label, p.detail));
    return row('finding', plural(Math.max(state.findings.issues, 1), 'finding'), sentence(p.label, p.detail));
  }
  if (p.needsYou) return row('owner', 'waiting on you', p.detail);
  if (state.staleEvidence) return row('stale', 'out of date', 'The branch changed after the last check. It checks again.');
  if (state.status === 'running') {
    const pr = state.progress;
    const text = pr?.expected ? `capturing ${pr.captured} of ${pr.expected}` : 'checking';
    return row('running', text, p.detail);
  }
  return row('queued', 'queued', p.detail);
}

// ── Goal criteria (R-17, R-19, R-20) ─────────────────────────────────────────

/** A criterion's name: its own label, else what it checks. */
export function criterionName(c: GoalCriterion): string {
  if (c.label) return c.label;
  switch (c.type) {
    case 'command': return c.command;
    case 'description': return c.description.length > 80 ? `${c.description.slice(0, 79)}…` : c.description;
    case 'all_prs_merged': return 'Every PR merged';
    case 'no_open_tasks': return 'No open tasks';
    case 'artifact_exists': return c.key ? `Artifact ${c.key} exists` : 'An artifact exists';
    case 'metric': return 'Metric';
    default: return 'Goal';
  }
}

/**
 * One row per goal criterion. A verdict counts only for the criterion it was
 * produced for: a stored fingerprint that no longer matches is stale.
 * UNVERIFIED, PENDING and NOT_EVALUATED never read as passed. On a mission
 * branch an unjudged criterion waits for the merge (R-13).
 */
export function criteriaChecks(criteria: readonly GoalCriterion[], state: GoalCriteriaState | null, ctx: { branch: 'mission-branch' | 'direct'; prMerged: boolean; target: string | null }): CheckRow[] {
  const byIndex = new Map((state?.criteria ?? []).map(e => [e.index, e]));
  const where = ctx.target ? `on ${ctx.target}` : 'on the target branch';
  return criteria.map((c, i) => {
    const e = byIndex.get(i) ?? null;
    const base = {
      key: `criterion-${i}`, kind: 'criterion' as const, label: criterionName(c), chip: 'goal', blocks: true,
      target: ctx.target, commit: null, actor: 'system' as CheckActor, problem: null, findings: null, repairs: [], evidence: [],
    };
    const row = (status: CheckStatus, text: string, detail: string | null, extra: Partial<CheckRow> = {}): CheckRow => ({ ...base, status, state: text, detail, ...extra });
    const afterMerge = ctx.branch === 'mission-branch' && !ctx.prMerged;
    const unjudged = () => afterMerge
      ? row('queued', 'after merge', `Checked ${where} after the mission PR merges.`)
      : row('queued', 'not checked', 'Not checked yet.');

    if (c.type === 'metric') return row('unable', 'no checker', 'Nothing can run this kind of criterion yet.', { actor: 'owner' });
    if (!e) return unjudged();
    if (e.fingerprint && e.fingerprint !== criterionFingerprint(c)) {
      return row('stale', 'out of date', 'The criterion changed after it was judged. It needs checking again.');
    }
    const evidence = e.evidence ?? null;
    switch (e.verdict) {
      case 'pass': return row('passed', 'passed', evidence, { actor: 'none' });
      case 'fail': return row('finding', 'not met', evidence, { problem: 'product' });
      case 'PENDING':
        return e.awaitingRunner
          ? row('unable', 'no runner', 'Waiting for a runner to check it.', { problem: 'system' })
          : row('running', 'checking', evidence);
      case 'NOT_EVALUATED': return row('unable', 'not judged', evidence ?? 'The check could not reach a verdict.', { problem: 'system' });
      default: return unjudged();
    }
  });
}

// ── Mission PR (R-21) ────────────────────────────────────────────────────────

/** The mission-to-trunk PR on a mission-branch mission. The owner is asked only under the human tier. */
export function missionPrCheck(pr: MissionIntegrationPrView, ctx: { mergeTier: MergeTier; target: string | null; buildComplete: boolean; visualHolds: boolean }): CheckRow {
  const into = ctx.target ?? 'the target branch';
  const base = {
    key: 'mission-pr', kind: 'mission_pr' as const, label: `Mission PR${pr.prNumber ? ` #${pr.prNumber}` : ''} into ${into}`,
    chip: null, blocks: true, target: ctx.target, commit: null, problem: null, findings: null, repairs: [],
    evidence: pr.prUrl ? [{ label: 'Open the PR', href: pr.prUrl }] : [],
  };
  const row = (status: CheckStatus, text: string, detail: string, actor: CheckActor, extra: Partial<CheckRow> = {}): CheckRow => ({ ...base, status, state: text, detail, actor, ...extra });
  switch (pr.state) {
    case 'merged': return row('passed', 'merged', `Merged into ${into}.`, 'none');
    case 'closed': return row('unable', 'closed', 'Closed without merging, so none of this work has shipped.', 'owner', { problem: 'product' });
    case 'not_opened':
      return row('queued', 'not open', ctx.buildComplete ? 'Opens when the last task PR merges.' : 'Opens when the build is done.', 'system');
    default:
      if (ctx.visualHolds) return row('queued', 'waiting', 'Merges after visual review.', 'system');
      if (ctx.mergeTier === 'human') return row('owner', 'waiting on you', 'You make the final merge. Task PRs merged on their own.', 'owner');
      if (ctx.mergeTier === 'agent-review') return row('running', 'reviewer deciding', 'Merges when the reviewer approves.', 'reviewer');
      return row('running', 'merging', 'Merges on its own once CI passes.', 'system');
  }
}

// ── Release (R-22, P-3) ──────────────────────────────────────────────────────

/** The release row, or null when no release is configured. Only healthy is delivered. */
export function releaseCheck(status: MissionReleaseStatus, label?: string | null): CheckRow | null {
  if (status === 'not_configured') return null;
  const base = { key: 'release', kind: 'release' as const, label: label ?? 'Release', chip: null, blocks: true, target: null, commit: null, findings: null, repairs: [], evidence: [] };
  const row = (s: CheckStatus, text: string, detail: string, actor: CheckActor, problem: CheckRow['problem'] = null): CheckRow => ({ ...base, status: s, state: text, detail, actor, problem });
  switch (status) {
    case 'waiting': return row('queued', 'waiting', 'Starts after the merge.', 'system');
    case 'dispatched': return row('running', 'started', 'Shows delivered once production is healthy.', 'system');
    case 'deploying': return row('running', 'deploying', 'Shows delivered once production is healthy.', 'system');
    case 'healthy': return row('passed', 'healthy', 'Production is healthy.', 'none');
    case 'failed': return row('finding', 'deploy failed', 'Not delivered until a deploy is healthy.', 'owner', 'system');
    default: return row('unable', 'unknown', 'The release state could not be read.', 'system', 'system');
  }
}

// ── The whole handoff ────────────────────────────────────────────────────────

/**
 * Rows in reading order (visual, mission PR, criteria, release) and the
 * Build / Verify / Deliver rail. The rail says which checkpoint the mission
 * waits on (R-13); it schedules nothing and its widths are not time (R-24).
 */
export function missionChecks(input: MissionChecksInput): MissionChecks {
  const { build, branch, target } = input;
  const buildComplete = build.total > 0 && build.done >= build.total;
  const missionPr = branch === 'mission-branch' ? input.integrationPr : null;
  const prMerged = missionPr?.state === 'merged';

  const visual = input.visual ? visualCheck(input.visual, { mergeTier: input.mergeTier, repairs: input.repairs, evidence: input.evidence?.visual }) : null;
  const visualHolds = !!visual && input.visual!.blocksMerge && !SETTLED.has(visual.status);
  const criteria = criteriaChecks(input.criteria, input.criteriaState, { branch, prMerged, target });
  const pr = missionPr ? missionPrCheck(missionPr, { mergeTier: input.mergeTier, target, buildComplete, visualHolds }) : null;
  const release = releaseCheck(input.release, input.releaseLabel);
  const rows = [visual, pr, ...criteria, release].filter((r): r is CheckRow => r != null);

  // Verify: the visual review and the criteria. Deliver: the mission PR and the release.
  const verifyRows = [visual, ...criteria].filter((r): r is CheckRow => r != null && r.blocks);
  const verifyOpen = verifyRows.filter(r => !SETTLED.has(r.status));
  const verifyDone = verifyOpen.length === 0;
  // On a mission branch, criteria judged after the merge do not hold up the merge (R-13).
  const onlyAfterMerge = verifyOpen.length > 0 && verifyOpen.every(r => r.kind === 'criterion' && r.state === 'after merge');
  const merged = branch === 'direct' ? buildComplete : prMerged;
  const deliverDone = merged && (!release || release.status === 'passed');
  const deliverHeld = pr?.status === 'unable' || release?.status === 'finding' || release?.status === 'unable';

  const buildStep: RailStep = build.total === 0
    ? { key: 'build', label: 'Build', state: 'todo', text: 'no tasks yet' }
    : buildComplete
      ? { key: 'build', label: 'Build', state: 'done', text: `${build.done} of ${build.total}` }
      : { key: 'build', label: 'Build', state: 'now', text: `${build.done} of ${build.total} landed` };

  const passedCount = verifyRows.filter(r => r.status === 'passed').length;
  const counted = verifyRows.filter(r => r.status !== 'not_applicable').length;
  const firstOpen = verifyOpen.find(r => r.kind === 'visual') ?? verifyOpen[0];
  const verifyText = verifyDone
    ? (counted === 0 ? 'nothing to check' : `${passedCount} of ${counted} passed`)
    : onlyAfterMerge ? `${plural(verifyOpen.length, 'check')} after merge` : `${firstOpen.label.toLowerCase() === 'visual review' ? '' : `${firstOpen.label}: `}${firstOpen.state}`;
  // Checks can start before the build ends (R-13): a visual review already at work shows here.
  const startedEarly = !!visual && EARLY.has(visual.status);
  const verifyStep: RailStep = !buildComplete && !startedEarly
    ? { key: 'verify', label: 'Verify', state: 'todo', text: 'after build' }
    : {
        key: 'verify', label: 'Verify', text: verifyText,
        state: verifyDone ? 'done' : onlyAfterMerge ? 'part' : verifyOpen.some(r => r.status === 'unable') ? 'held' : 'now',
      };

  const into = target ?? 'the target';
  const deliverReady = buildComplete && (verifyDone || onlyAfterMerge);
  const deliverOpen = [pr, release].find(r => r && !SETTLED.has(r.status)) ?? null;
  const deliverStep: RailStep = deliverDone
    ? { key: 'deliver', label: 'Deliver', state: 'done', text: release ? 'released, healthy' : `merged into ${into}` }
    : deliverHeld
      ? { key: 'deliver', label: 'Deliver', state: 'held', text: deliverOpen?.state ?? 'held' }
      : deliverReady || (merged && !!release)
        ? { key: 'deliver', label: 'Deliver', state: 'now', text: deliverOpen ? (deliverOpen.actor === 'owner' ? 'your merge' : deliverOpen.state) : `into ${into}` }
        : { key: 'deliver', label: 'Deliver', state: 'todo', text: visualHolds ? 'after visual review' : `into ${into}` };

  const checkpoint: RailKey | 'done' = !buildComplete ? 'build'
    : deliverDone && verifyDone ? 'done'
      : deliverStep.state === 'now' || deliverStep.state === 'held' ? 'deliver'
        : 'verify';

  return { rows, rail: [buildStep, verifyStep, deliverStep], buildComplete, delivered: deliverDone, checkpoint };
}

// ── Build-only estimate (R-23, R-24) ─────────────────────────────────────────

/**
 * The build estimate, labelled build only, from the minutes the unfinished
 * build tasks are expected to take. Null when anything removes the promise: a
 * person's decision, a capacity or budget wait, an outside wait, or no
 * estimate on any open task. Never an estimate for checks or delivery.
 */
export function buildEstimateLine(openMinutes: readonly (number | null | undefined)[], held: boolean): string | null {
  if (held) return null;
  const known = openMinutes.filter((m): m is number => typeof m === 'number' && Number.isFinite(m) && m > 0);
  if (known.length === 0 || known.length < openMinutes.length) return null;
  const longest = Math.max(...known);
  const total = known.reduce((a, b) => a + b, 0);
  const lo = Math.round(longest);
  const hi = Math.round(total);
  return lo === hi ? `build only: about ${lo} min` : `build only: ${lo} to ${hi} min`;
}
