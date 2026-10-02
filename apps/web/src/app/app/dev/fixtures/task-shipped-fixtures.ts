/**
 * The completed task page's "What shipped" header and the phone "Checks by
 * commit" list, over illustrative data (no database, never real captures):
 *
 *   ?state=task-shipped&variant=open | merged-shots | recovered | no-lede
 *   ?state=commit-checks&variant=all-passed | one-failed | two-attempts   (omit: all three)
 */
import type { CiCheckRun, PrCommitChecks, PrOutcome } from '@/components/task/PrCard';
import { buildTaskShippedView, type BuildTaskShippedViewInput, type TaskShippedView } from '@/app/app/(protected)/tasks/[id]/task-shipped-header';

export const TASK_SHIPPED_VARIANTS = ['open', 'merged-shots', 'recovered', 'no-lede'] as const;
export type TaskShippedVariant = (typeof TASK_SHIPPED_VARIANTS)[number];

export const COMMIT_CHECKS_VARIANTS = ['all-passed', 'one-failed', 'two-attempts'] as const;
export type CommitChecksVariant = (typeof COMMIT_CHECKS_VARIANTS)[number];

export function parseTaskShippedVariant(raw: string | null): TaskShippedVariant {
  return (TASK_SHIPPED_VARIANTS as readonly string[]).includes(raw ?? '') ? (raw as TaskShippedVariant) : 'open';
}

/** Null = every variant, stacked. */
export function parseCommitChecksVariant(raw: string | null): CommitChecksVariant | null {
  return (COMMIT_CHECKS_VARIANTS as readonly string[]).includes(raw ?? '') ? (raw as CommitChecksVariant) : null;
}

export const FIXTURE_TASK_TITLE = 'Completed task page leads with what shipped';
const PR_URL = 'https://github.com/example/app/pull/1234';
const LEDE = 'A finished task now opens on a plain sentence about what changed, with the merge button full width on a phone. Checked at phone and desktop width.';
const HANDOFF = [
  'Implemented the What shipped header on the task page.',
  '',
  '- `TaskShippedHeader.tsx`: title, lede card, Your move, disclosures',
  '- `task-shipped-header.ts`: pure view builder; `buildTaskShippedView`',
  '- `PrCard.tsx`: `hideAction`, stacked header below md',
  '- Tests: `task-shipped-header.test.ts` (14), `commit-checks-view.test.ts` (9)',
].join('\n');

const CHECK_NAMES = [
  'Build / lint + type check',
  'Build / unit tests',
  'Build / build',
  'Sandbox isolation',
  'Schema Drift / check-prod',
  'Tier-2 CI — assertion evaluation (blocking)',
  'Specs lint',
  'No production data',
  'Changes',
];

const passed = (name: string): CiCheckRun => ({ name, status: 'completed', conclusion: 'success', detailsUrl: 'https://github.com/example/app/actions' });
const failed = (name: string): CiCheckRun => ({ name, status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/example/app/actions' });

export function fixtureCommits(variant: CommitChecksVariant): PrCommitChecks[] {
  if (variant === 'all-passed') {
    return [{ attempt: 1, sha: '69786bc', state: 'passed', failure: null, runs: CHECK_NAMES.map(passed) }];
  }
  const oneFailed: PrCommitChecks = {
    attempt: 1,
    sha: '69786bc',
    state: 'failed',
    failure: { job: 'Build / unit tests', test: 'task-shipped-header.test.ts', excerpt: 'expect(received).toBe(expected) — Expected: "Shipped", Received: "Done"' },
    runs: CHECK_NAMES.map(n => (n === 'Build / unit tests' ? failed(n) : passed(n))),
  };
  if (variant === 'one-failed') return [oneFailed];
  return [
    { ...oneFailed, fix: 'Read the merge stamp before the lifecycle column.' },
    { attempt: 2, sha: 'a41f0e2', state: 'passed', failure: null, runs: CHECK_NAMES.map(passed) },
  ];
}

export function fixtureOutcome(variant: TaskShippedVariant): PrOutcome {
  const twoAttempts = variant === 'recovered';
  return {
    repoLabel: 'example/app',
    summary: null,
    totals: { add: 412, rem: 96, files: 11, commits: twoAttempts ? 4 : 3, attempts: twoAttempts ? 2 : 1, claimToMerge: variant === 'merged-shots' ? '2h 14m' : null },
    attempts: twoAttempts ? [{ add: 398, rem: 90, files: 10 }, { add: 14, rem: 6, files: 1 }] : [{ add: 412, rem: 96, files: 11 }],
    lineage: [],
    commits: fixtureCommits(twoAttempts ? 'two-attempts' : 'all-passed'),
  };
}

export const FIXTURE_HERO_SHOTS = [
  { artifactId: 'fixture-shot-mobile', route: '/app/tasks/:id', viewport: 'mobile' as const, verdict: 'ok' as const },
  { artifactId: 'fixture-shot-desktop', route: '/app/tasks/:id', viewport: 'desktop' as const, verdict: 'ok' as const },
];

export function taskShippedFixtureInput(variant: TaskShippedVariant): BuildTaskShippedViewInput {
  const merged = variant === 'merged-shots';
  return {
    taskStatus: 'completed',
    taskMode: 'execution',
    conventionalType: 'feat',
    category: 'feature',
    record: variant === 'no-lede'
      ? null
      : {
          version: 1,
          lede: LEDE,
          changeType: merged ? 'frontend' : 'both',
          offPlan: merged ? ['The desktop layout was left as it was.'] : [],
          prNumber: 1234,
          computedAt: '2026-01-10T14:00:00.000Z',
        },
    summary: HANDOFF,
    summarySource: 'agent',
    pr: { url: PR_URL, number: 1234, lifecycle: merged ? 'merged' : 'ci_green', merged },
    heroShots: merged ? FIXTURE_HERO_SHOTS : [],
    errorTraceCount: variant === 'recovered' ? 1 : 0,
    inRelease: false,
  };
}

export function taskShippedFixtureView(variant: TaskShippedVariant): TaskShippedView {
  return buildTaskShippedView(taskShippedFixtureInput(variant))!;
}

export const FIXTURE_RUN_DETAILS = [
  { label: 'Runner', value: 'example-runner' },
  { label: 'Turns', value: '142' },
  { label: 'Took', value: '1h 12m' },
  { label: 'Tier', value: 'Premium' },
];
