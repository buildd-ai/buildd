/**
 * An in-memory mission for the visual-review end-to-end tests. Test-only:
 * nothing in the app imports it.
 *
 * It stands in for what the database and GitHub hand the server half
 * (`getMissionVisualReviewState`, `scheduleMissionVisualReview`): the policy
 * inputs, the integration branch's changed files and head, the audit ledger,
 * the review the latest audit produced, a person's waiver and the integration
 * PR. `tick` then runs the SAME pure chain the server runs, in the same order
 * and with the same gating, over those facts:
 *
 *   assessVisualImpact -> uiChangeFromImpact -> deriveMissionVisualReview
 *     -> planVisualReviewSchedule -> (execute the plan on the ledger)
 *     -> decideReadyToMerge -> presentVisualReview
 *
 * so a scenario reads like the mission's life and every step is the production
 * function, not a restatement of it. What this does NOT cover is the SQL and
 * GitHub glue in the `*-load.ts` files; those have their own rendered-SQL tests.
 * Illustrative ids and SHAs only.
 */
import type { VisualReviewPolicyMode } from '@buildd/shared';
import { decideReadyToMerge, type ReadyToMergeDecision } from '../ready-to-merge';
import { assessVisualImpact, uiChangeFromImpact, type ImpactDecider, type ImpactFile, type VisualImpactAssessment } from './visual-review-impact';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { presentVisualReview, type VisualReviewPresentation } from './visual-review-presentation';
import { planVisualReviewSchedule, autoRetriesLeft, type ScheduleAction, type ScheduleAudit } from './visual-review-schedule';
import {
  captureConfigErrorFrom,
  deriveMissionVisualReview,
  integrationPrFromDeliveryState,
  type MissionVisualReviewState,
  type VisualReviewCaptureConfigError,
  type VisualReviewStateInput,
} from './visual-review-state';

type Review = NonNullable<VisualReviewStateInput['review']>;

/** What a finished (or running) audit left behind, as the `VisualReviewModel` slice the state reads. */
export const REVIEW = {
  reviewed: { phase: 'reviewed', screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
  capturing: { phase: 'capturing', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 1, expected: 4 },
  fixing: { phase: 'fixing', screens: 4, effectiveIssues: 1, awaitingHuman: 0, openFixes: 1, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
  unsure: { phase: 'needs_you', screens: 4, effectiveIssues: 0, awaitingHuman: 1, openFixes: 0, roundCapOpen: false, needsYouReason: 'unsure', captured: 0, expected: null },
  exhausted: { phase: 'needs_you', screens: 4, effectiveIssues: 1, awaitingHuman: 0, openFixes: 0, roundCapOpen: true, needsYouReason: 'round_cap', captured: 0, expected: null },
  bootFailed: { phase: 'boot_failed', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
  queued: { phase: 'queued', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
  failed: { phase: 'failed', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
  noBrowser: { phase: 'no_browser_runner', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
} satisfies Record<string, Review>;

export interface FakeAudit {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  round: number;
  headSha: string | null;
  createdAt: number;
  updatedAt: number;
  /** The review this audit produced; null until it has captured anything. */
  review: Review | null;
  /** Failure text (`captureConfigErrorFrom` reads it). */
  result?: string | null;
}

export interface FakeMission {
  /** Policy inputs, as resolved by `resolveVisualReviewPolicy`. */
  team: VisualReviewPolicyMode | null;
  workspace: VisualReviewPolicyMode | null;
  autoSurfaceAudit: boolean | null;
  /** Integration branch vs trunk. null = the diff could not be read. */
  files: ImpactFile[] | null;
  headSha: string | null;
  /** null = a direct-to-trunk mission: no integration PR exists. */
  pr: { number: number; deliveryState: string } | null;
  /** UI-touching builder tasks are terminal. */
  workLanded: boolean;
  /** Why unmerged task work holds the mission PR (`guardMissionPrMerge`'s workHolder). */
  workHolder: string | null;
  waiver: { reason: string; actorLabel: string | null; at: string } | null;
  audits: FakeAudit[]; // oldest first
  browserRunnerOnline: boolean | null;
  executorLocal: boolean;
  now: number;
  /** Jev's answers, in order. Absent = the model must not be asked. */
  jev: Array<Awaited<ReturnType<ImpactDecider>>>;
  jevAsked: number;
  /** Every `requestMissionSurfaceAudit` the plan resulted in. */
  filed: Array<{ headSha: string; round: number; reason: string; attempt: number }>;
  nextAuditId: number;
}

export const MIN = 60_000;
export const T0 = Date.parse('2026-10-12T12:00:00Z');

export function newMission(over: Partial<FakeMission> = {}): FakeMission {
  return {
    team: null,
    workspace: null,
    autoSurfaceAudit: true,
    files: [{ path: 'apps/web/src/components/Banner.tsx', patch: null }],
    headSha: 'aaaa1111',
    pr: { number: 9, deliveryState: 'OPEN' },
    workLanded: true,
    workHolder: null,
    waiver: null,
    audits: [],
    browserRunnerOnline: true,
    executorLocal: false,
    now: T0,
    jev: [],
    jevAsked: 0,
    filed: [],
    nextAuditId: 1,
    ...over,
  };
}

/** Files, shaped as the compare API returns them. */
export const file = (path: string, ...patchLines: string[]): ImpactFile => ({
  path,
  patch: patchLines.length ? ['@@ -1,3 +1,3 @@', ...patchLines].join('\n') : null,
});
export const RENDERING_EDIT = file('apps/web/src/components/Banner.tsx', '-  <p>Hi</p>', '+  <p className="font-bold">Hi</p>');
export const TEST_EDIT = file('apps/web/src/components/Banner.test.tsx', '-  expect(a)', '+  expect(b)');
export const DOC_EDIT = file('docs/specs/foo.md', '-a', '+b');
export const CSS_EDIT = file('apps/web/src/app/globals.css', '-  --space: 4px;', '+  --space: 6px;');
export const TOKEN_EDIT = file('packages/ui/tokens/colors.ts', '-  a', '+  b');
/** UI-path code the rules cannot rule out: Jev's to judge. */
export const SCREEN_EDIT = file('apps/web/src/app/app/(protected)/tasks/page.tsx', '-  <h1>Tasks</h1>', '+  <h1 className="text-xl">Tasks</h1>');
export const RISKY_FLOW_EDIT = file('apps/web/src/components/onboarding/Step.tsx', '-  <p>Next</p>', '+  <p className="mt-2">Next</p>');
export const AMBIGUOUS_EDIT = file('apps/web/src/components/useThing.ts', ' export function useThing() {', '-  return a;', '+  return a + 1;', ' }');

export const jevSays = (decision: 'no_visual_impact' | 'review_required' | 'insufficient_evidence', confidence = 0.95): Awaited<ReturnType<ImpactDecider>> =>
  ({ decision, confidence, reasonCode: decision === 'no_visual_impact' ? 'reason_logic_only' : 'reason_markup_changed', source: 'model' });

export interface Tick {
  assessment: VisualImpactAssessment | null;
  /** What every surface and merge door sees BEFORE the scheduler acts on this pass. */
  state: MissionVisualReviewState;
  /** The state once the plan's filing / re-stamping is applied: what the next reader sees. */
  after: MissionVisualReviewState;
  plan: ScheduleAction;
  merge: ReadyToMergeDecision;
  view: VisualReviewPresentation;
}

const ledgerOf = (m: FakeMission): ScheduleAudit[] =>
  [...m.audits].reverse().map(a => ({
    id: a.id,
    status: a.status,
    round: a.round,
    headSha: a.headSha,
    updatedAt: a.updatedAt,
    captureConfigError: a.status === 'failed' ? captureConfigErrorFrom(a.result) : null,
  }));

function stateOf(m: FakeMission, uiChange: VisualReviewStateInput['uiChange']): MissionVisualReviewState {
  const policy = resolveVisualReviewPolicy({ team: m.team, workspace: m.workspace, mission: { autoSurfaceAudit: m.autoSurfaceAudit } });
  const latest = m.audits[m.audits.length - 1] ?? null;
  const failedOnHead = m.headSha ? m.audits.filter(a => a.status === 'failed' && a.headSha === m.headSha).length : 0;
  const config = latest?.status === 'failed' ? captureConfigErrorFrom(latest.result) : null;
  return deriveMissionVisualReview({
    policy,
    uiChange,
    audit: latest ? { id: latest.id, createdAt: new Date(latest.createdAt).toISOString(), errorType: null } : null,
    review: latest ? (latest.review ?? REVIEW.queued) : null,
    waiver: m.waiver,
    auditedSha: latest ? latest.headSha : null,
    autoRetriesLeft: autoRetriesLeft(failedOnHead),
    captureConfigError: config as VisualReviewCaptureConfigError | null,
    branch: {
      headSha: m.headSha,
      base: 'dev',
      integrationPr: m.pr ? integrationPrFromDeliveryState(m.pr.number, m.pr.deliveryState) : null,
      workLanded: m.workLanded,
    },
  });
}

/**
 * One pass of the scheduler plus a read of every surface: the order
 * `scheduleMissionVisualReview` uses. `ownerMergesIntegration` is the merge
 * policy's question (tier `human`), independent of visual review.
 */
export async function tick(m: FakeMission, opts: { ownerMergesIntegration?: boolean } = {}): Promise<Tick> {
  const policy = resolveVisualReviewPolicy({ team: m.team, workspace: m.workspace, mission: { autoSurfaceAudit: m.autoSurfaceAudit } });
  const gateUnknown: VisualReviewStateInput['uiChange'] = { state: 'unknown', source: null, uiFiles: 0 };
  let state = stateOf(m, gateUnknown);

  // The classifier answers "does this owe a review" until something is filed or the pass goes stale.
  let assessment: VisualImpactAssessment | null = null;
  if (m.headSha && state.scope.workLanded && ['optional', 'not_applicable', 'needed'].includes(state.status)) {
    const decide: ImpactDecider = async () => {
      const next = m.jev[m.jevAsked++];
      if (!next) throw new Error('Jev was asked but the scenario gave no answer');
      return next;
    };
    assessment = await assessVisualImpact({ policy, files: m.files, headSha: m.headSha, decide });
    state = stateOf(m, uiChangeFromImpact(assessment, m.headSha));
  }

  const plan = planVisualReviewSchedule({
    state,
    impact: assessment ? { verdict: assessment.verdict, headSha: assessment.headSha } : null,
    audits: ledgerOf(m),
    browserRunnerOnline: m.browserRunnerOnline,
    executorLocal: m.executorLocal,
    now: m.now,
  });

  if (plan.action === 'enqueue') {
    m.filed.push({ headSha: plan.headSha, round: plan.round, reason: plan.reason, attempt: plan.attempt });
    // `requestMissionSurfaceAudit` replaces a failed or cancelled audit and is idempotent otherwise.
    m.audits.push({
      id: `audit-${m.nextAuditId++}`, status: 'pending', round: plan.round, headSha: plan.headSha,
      createdAt: m.now, updatedAt: m.now, review: null,
    });
  } else if (plan.action === 'restamp') {
    const a = m.audits.find(x => x.id === plan.auditId)!;
    a.headSha = plan.headSha;
  }
  const after = plan.action === 'enqueue' || plan.action === 'restamp'
    ? stateOf(m, assessment ? uiChangeFromImpact(assessment, m.headSha) : gateUnknown)
    : state;

  const merge = decideReadyToMerge({ kind: 'mission_integration_pr', workHolder: m.workHolder, visual: state });
  return { assessment, state, after, plan, merge, view: presentVisualReview(state, opts) };
}

/** The latest audit starts, finishes, or fails. */
export function finishAudit(m: FakeMission, how: { status: FakeAudit['status']; review?: Review | null; result?: string | null }): FakeAudit {
  const a = m.audits[m.audits.length - 1]!;
  a.status = how.status;
  a.updatedAt = m.now;
  if (how.review !== undefined) a.review = how.review;
  if (how.result !== undefined) a.result = how.result;
  return a;
}

/** Another commit lands on the integration branch (a fix merged, a task PR merged). */
export const moveHead = (m: FakeMission, headSha: string, files?: ImpactFile[]) => {
  m.headSha = headSha;
  if (files) m.files = [...(m.files ?? []), ...files];
};
export const advance = (m: FakeMission, ms: number) => { m.now += ms; };
