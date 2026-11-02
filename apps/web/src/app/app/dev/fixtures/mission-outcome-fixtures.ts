/**
 * `?state=mission-outcome&variant=`: a completed mission led by its outcome
 * (Navigation d25d923d R-23 to R-27, Mission checks 072de598 I-27 to I-30),
 * built through the real board, checks and outcome projections. Nothing here
 * restates their words. Illustrative data only.
 *
 * - `research`: the shape that triggered the rule. Eight read-through tasks
 *   finished with no PR, ten reports, one from the closeout task, a mission
 *   branch and a release configured. Its record predates the rule, so the
 *   closeout fallback picks the outcome.
 * - `research-no-primary`: three reports and no closeout report.
 * - `mixed`: three merged task PRs and a report the author nominated.
 * - `engineering`: a delivered code mission with a What shipped lede.
 * - `legacy`: a delivered code mission with no What shipped record.
 */
import { buildMissionBoard, type BoardTaskInput, type MissionBoardModel } from '@/lib/mission-board';
import { buildOutcomeHero, missionOutcome, type OutcomeArtifactInput, type OutcomeHeroView } from '@/lib/mission-outcome';
import { buildShippedHeaderView, type ShippedHeaderView } from '@/lib/mission-shipped-header';
import type { MissionChecksSource } from '@/app/app/(protected)/missions/[id]/MissionOverview';
import type { ArtifactViewerItem } from '@/components/ArtifactViewer';
import { handoffFixture, stripFixtureId, stripLanded, stripTask, stripWorker } from './mission-task-strip-fixtures';
import { MISSION_OUTCOME_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_OUTCOME_VARIANTS = ['research', 'research-no-primary', 'mixed', 'engineering', 'legacy'] as const;
export type MissionOutcomeVariant = (typeof MISSION_OUTCOME_VARIANTS)[number];

export function parseMissionOutcomeVariant(q: URLSearchParams): MissionOutcomeVariant {
  const v = q.get('variant');
  return (MISSION_OUTCOME_VARIANTS as readonly string[]).includes(v ?? '') ? (v as MissionOutcomeVariant) : 'research';
}

export const missionOutcomeLinks = () =>
  MISSION_OUTCOME_VARIANTS.map(v => ({ label: v, href: `/app/dev/fixtures?state=${MISSION_OUTCOME_FIXTURE_STATE}&variant=${v}` }));

export interface MissionOutcomeFixture {
  missionId: string;
  title: string;
  goal: string;
  model: MissionBoardModel;
  checks: MissionChecksSource;
  hero: OutcomeHeroView | null;
  shipped: ShippedHeaderView | null;
  records: ArtifactViewerItem[];
  outcome: { primaryId: string | null; eligibleIds: string[] } | null;
}

const MISSION_ID = stripFixtureId(990);
const CLOSEOUT_N = 980;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const COMPLETED_AT = new Date(T0 + 90 * 60_000).toISOString();

/** A task that finished with a report and no PR. */
function reported(n: number, title: string): BoardTaskInput {
  return stripTask(n, title, {
    status: 'completed', outputRequirement: 'artifact_required', roleSlug: 'researcher',
    workers: [stripWorker(`w${n}`, { startedAt: T0 + n * 3 * 60_000, completedAt: T0 + (n * 3 + 2) * 60_000, updatedAt: T0 + (n * 3 + 2) * 60_000 })],
  });
}

const READ_THROUGHS = [
  'Read-through: harness A', 'Read-through: harness B', 'Read-through: harness C', 'Read-through: harnesses D and E',
  'Read-through: harnesses F and G', 'Read-through: harnesses H and I', 'Read-through: harnesses J and K', 'Synthesis: what to adopt across harnesses',
];

const FINAL_BODY = [
  '# Mission final: harness read-throughs and what to adopt',
  '',
  'Eight open-source agent harnesses were read end to end and each idea got an adopt, adapt or skip verdict. No code or PR was produced; the result is the verdict table and three adoptions ranked by effort.',
  '',
  '## Verdicts',
  '',
  '| Idea | Verdict |',
  '| --- | --- |',
  '| Repository map for context | Adopt |',
].join('\n');

const report = (id: string, title: string, taskN: number, body: string): { input: OutcomeArtifactInput; item: ArtifactViewerItem } => ({
  input: { id, title, type: 'report', key: null, metadata: {}, taskId: stripFixtureId(taskN) },
  item: {
    id, type: 'report', title, content: body, shareToken: null, visibility: 'private', metadata: {},
    createdAt: new Date(T0 + taskN * 60_000).toISOString(), taskTitle: taskN === CLOSEOUT_N ? 'Aggregate results' : READ_THROUGHS[taskN - 1] ?? 'Task',
  } as ArtifactViewerItem,
});

function researchFixture(withCloseout: boolean): MissionOutcomeFixture {
  const count = withCloseout ? 8 : 3;
  const tasks = READ_THROUGHS.slice(0, count).map((t, i) => reported(i + 1, t));
  // The closeout task is bookkeeping, as the server files it: not a build cell.
  if (withCloseout) tasks.push({ ...reported(CLOSEOUT_N, 'Aggregate results: harness read-throughs'), taskClass: 'bookkeeping' });
  const model = buildMissionBoard({ now: T0 + 100 * 60_000, missionCreatedAt: T0, missionCompletedAt: Date.parse(COMPLETED_AT), missionStatus: 'completed', tasks });
  const reports = withCloseout
    ? [
        ...READ_THROUGHS.map((t, i) => report(stripFixtureId(700 + i), t.replace('Read-through: ', 'Read-through report: '), i + 1, `# ${t}\n\nWhat it is and what to take from it.`)),
        report(stripFixtureId(708), 'Addendum: two more harnesses', 7, '# Addendum\n\nTwo more harnesses, same format.'),
        report(stripFixtureId(709), 'Mission final: harness read-throughs and what to adopt', CLOSEOUT_N, FINAL_BODY),
      ]
    : READ_THROUGHS.slice(0, 3).map((t, i) => report(stripFixtureId(700 + i), t.replace('Read-through: ', 'Read-through report: '), i + 1, `# ${t}\n\nWhat it is and what to take from it.`));
  const inputs = reports.map(r => r.input);
  const closeoutTaskIds = new Set(withCloseout ? [stripFixtureId(CLOSEOUT_N)] : []);
  const base = { missionId: MISSION_ID, artifacts: inputs, storedPrimary: null, closeoutTaskIds, deliverablePrCount: 0 };
  const sel = missionOutcome(base);
  const hero = buildOutcomeHero({
    ...base, tasks: { merged: 0, done: count }, lede: null,
    primaryContent: sel.primary ? reports.find(r => r.input.id === sel.primary!.artifact.id)?.item.content ?? null : null,
    shipped: false, target: 'dev', release: 'waiting',
  });
  return {
    missionId: MISSION_ID,
    title: withCloseout ? 'Read through open-source agent harnesses and say what to adopt' : 'Compare three agent harnesses',
    goal: 'Read each harness, give every idea an adopt, adapt or skip verdict, and rank what to take.',
    model,
    checks: {
      missionId: MISSION_ID, branch: 'mission-branch', target: 'dev', mergeTier: 'agent-review', visual: null, criteria: [], criteriaState: null,
      integrationPr: { branch: 'mission/harness-read-throughs', state: 'not_opened', prNumber: null, prUrl: null, taskId: null } as MissionChecksSource['integrationPr'],
      release: 'waiting', outcome: { class: sel.class, ready: true },
    },
    hero,
    shipped: null,
    records: reports.map(r => r.item),
    outcome: { primaryId: sel.primary?.artifact.id ?? null, eligibleIds: sel.pool.map(a => a.id) },
  };
}

const SHIPPED_RECORD = (lede: string | null) => ({
  version: 1, lede, changeType: 'frontend', heroShots: [], offPlan: [], authorTaskId: null, origin: lede ? 'author' : 'no_author', completedAt: COMPLETED_AT,
});

function codeFixture(variant: 'mixed' | 'engineering' | 'legacy'): MissionOutcomeFixture {
  const base = handoffFixture('handoff-delivered', { now: T0 + 100 * 60_000, missionCreatedAt: T0, missionStatus: 'active' });
  const baseChecks = base.checks!;
  const mixed = variant === 'mixed';
  const tasks = mixed
    ? [stripLanded(1, 'feat(pricing): apply the new tiers'), stripLanded(2, 'feat(pricing): show tier on invoices'), stripLanded(3, 'test(pricing): tier boundaries'), reported(4, 'Research: pricing interviews')]
    : null;
  const model = tasks
    ? buildMissionBoard({ now: T0 + 100 * 60_000, missionCreatedAt: T0, missionCompletedAt: Date.parse(COMPLETED_AT), missionStatus: 'completed', tasks })
    : base.model;
  const finding = report(stripFixtureId(720), 'Pricing interviews: what customers said', 4, '# Pricing interviews\n\nTwelve customers were interviewed; most wanted a cheaper entry tier, which the new tiers now offer.');
  const sel = mixed
    ? missionOutcome({ missionId: MISSION_ID, artifacts: [finding.input], storedPrimary: { artifactId: finding.input.id, source: 'author' }, closeoutTaskIds: new Set(), deliverablePrCount: 3 })
    : null;
  const shipped = variant === 'legacy'
    ? null
    : buildShippedHeaderView(SHIPPED_RECORD(mixed
      ? 'Prices now follow the three tiers the interviews pointed to, on the pricing page and on invoices.'
      : 'Billing exports now run on a schedule and arrive as one file. Checked at phone and desktop width.'), COMPLETED_AT);
  const hero = mixed && sel
    ? buildOutcomeHero({
        missionId: MISSION_ID, artifacts: [finding.input], storedPrimary: { artifactId: finding.input.id, source: 'author' }, closeoutTaskIds: new Set(),
        deliverablePrCount: 3, tasks: { merged: 3, done: 1 }, lede: shipped?.lede ?? null, primaryContent: finding.item.content,
        shipped: true, target: 'dev', release: 'waiting',
      })
    : null;
  return {
    missionId: MISSION_ID,
    title: mixed ? 'Reprice the plans from customer interviews' : 'Scheduled billing exports',
    goal: mixed ? 'Interview customers, then change the tiers to match what they said.' : 'Billing exports run on a schedule and arrive as one file.',
    model,
    checks: mixed
      ? { ...baseChecks, missionId: MISSION_ID, visual: null, release: 'waiting', outcome: { class: 'mixed', ready: true } }
      : { ...baseChecks, missionId: MISSION_ID },
    hero,
    shipped,
    records: mixed ? [finding.item] : [],
    outcome: sel ? { primaryId: sel.primary?.artifact.id ?? null, eligibleIds: sel.pool.map(a => a.id) } : null,
  };
}

export function missionOutcomeFixture(variant: MissionOutcomeVariant): MissionOutcomeFixture {
  if (variant === 'research') return researchFixture(true);
  if (variant === 'research-no-primary') return researchFixture(false);
  return codeFixture(variant);
}
