/**
 * A red PR whose only failing jobs are known flakes: re-run them, file the
 * flake, spend no CI-fix attempt.
 *
 * A job is a known flake here when both rules of `red-check-cause.ts` hold:
 *  - it is scoped to paths the PR's diff does not touch (`unrelated_to_diff`),
 *    so the PR's copy of everything it tests is the base's;
 *  - the base branch's run at the same time did not have it red (`baseGreen`),
 *    so trunk is not broken (that is the kernel's BLOCKED_ON_TRUNK, not this).
 * Then a builder has nothing in the PR to fix. Before this, one Windows
 * teardown EBUSY spent both CI-fix attempts of a web-only PR, and the second
 * builder pushed an empty commit to get the re-run this does.
 *
 * Bounded by the run's `run_attempt`: one re-run per head. A flake that fails
 * again goes to the normal fix path. Each re-run appends to one open
 * `[friction]` task per flaky test (signature `ci-flake:<job>::<file>::<test>`),
 * so a test that recurs across PRs collects its occurrences in one place.
 *
 * Never throws: any read or write failure reports `rerun: false` and the
 * caller falls through to its normal path.
 */
import type { RedCheckRecord, RedJob } from '@/lib/red-check-cause';

/** Total attempts of one workflow run (the first plus re-runs) before a flake is no longer trusted as the cause. */
export const MAX_FLAKE_RUN_ATTEMPTS = 2;
/** Flaky tests filed per re-run: a job failing more than this many is not a single flake. */
const MAX_TESTS_FILED = 5;
const MAX_NAME = 150;

export interface FlakyTest {
  job: string;
  /** The test file the runner's digest names above the test, when it names one. */
  file: string | null;
  /** The failing test; null when the job's lines name none. */
  test: string | null;
  signature: string;
}

export type FlakeRerunOutcome =
  | { rerun: true; runId: number; runAttempt: number; tests: FlakyTest[]; friction: Array<{ signature: string; taskId: string; outcome: 'created' | 'appended' }> }
  | { rerun: false; reason: 'no_record' | 'not_flake' | 'attempts_exhausted' | 'rerun_failed' };

export interface FlakeRerunInput {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  /** Where the friction lands: the PR's workspace, whose test it is. */
  workspaceId: string;
}

export interface FlakeRerunDeps {
  /** The red head read with the PR's diff and base (`readRedChecks` with `pr`). */
  read(input: FlakeRerunInput): Promise<RedCheckRecord | null>;
  rerunFailedJobs(input: FlakeRerunInput, runId: number): Promise<void>;
  findOpenBug(workspaceId: string, signature: string): Promise<{ id: string } | null>;
  appendToBug(taskId: string, text: string): Promise<void>;
  fileBug(row: { workspaceId: string; title: string; description: string; signature: string; excerpt: string }): Promise<{ id: string } | null>;
}

/** The failed jobs when every one is a known flake, else null. */
export function knownFlakeJobs(record: Pick<RedCheckRecord, 'jobs'>): RedJob[] | null {
  if (record.jobs.length === 0) return null;
  return record.jobs.every(j => j.rule === 'unrelated_to_diff' && j.baseGreen === true) ? [...record.jobs] : null;
}

const clean = (s: string) => s.replace(/\s+\[[\d.]+\s*m?s\]$/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
const TEST_FILE = /^\s*(?:--- )?(\S+\.test\.[cm]?[jt]sx?)(?: ---)?\s*$/;
const TEST_LINE = [/^\s*\(fail\)\s+(.+)$/, /^\s*x\s+(.+)$/, /^\s*[✗✖✕×]\s+(.+)$/];

export function flakeSignature(job: string, file: string | null, test: string | null): string {
  return ['ci-flake:' + clean(job).toLowerCase(), file ? clean(file).toLowerCase() : '', test ? clean(test).toLowerCase() : '']
    .join('::').replace(/(::)+$/, '');
}

/** One entry per failing test the job's lines name, under the file named above it; the bare job when they name none. */
export function flakyTestsOf(jobs: readonly RedJob[]): FlakyTest[] {
  const out = new Map<string, FlakyTest>();
  for (const job of jobs) {
    let file: string | null = null;
    let named = false;
    for (const line of (job.lines ?? '').split('\n')) {
      const f = line.match(TEST_FILE);
      if (f) { file = f[1]; continue; }
      const t = TEST_LINE.map(re => line.match(re)?.[1]).find(Boolean);
      if (!t) continue;
      named = true;
      const test = clean(t);
      const signature = flakeSignature(job.name, file, test);
      if (!out.has(signature)) out.set(signature, { job: job.name, file, test, signature });
    }
    if (!named) {
      const signature = flakeSignature(job.name, null, null);
      out.set(signature, { job: job.name, file: null, test: null, signature });
    }
  }
  return [...out.values()].slice(0, MAX_TESTS_FILED);
}

function occurrence(input: FlakeRerunInput, record: RedCheckRecord, at: Date): string {
  const runUrl = record.runId != null ? `https://github.com/${input.repoFullName}/actions/runs/${record.runId}` : 'unknown run';
  return `- ${at.toISOString()}: PR #${input.prNumber} @ ${input.headSha.slice(0, 10)}, attempt ${record.runAttempt ?? 1} of ${runUrl}: re-ran the failed jobs, no CI-fix attempt spent.`;
}

function label(t: FlakyTest): string {
  return t.test ? `${t.test}${t.file ? ` (${t.file})` : ''}` : t.job;
}

async function fileFriction(input: FlakeRerunInput, record: RedCheckRecord, tests: FlakyTest[], d: FlakeRerunDeps, now: Date) {
  const filed: Array<{ signature: string; taskId: string; outcome: 'created' | 'appended' }> = [];
  const line = occurrence(input, record, now);
  for (const t of tests) {
    try {
      const open = await d.findOpenBug(input.workspaceId, t.signature);
      if (open) {
        await d.appendToBug(open.id, `\n${line}`);
        filed.push({ signature: t.signature, taskId: open.id, outcome: 'appended' });
        continue;
      }
      const bug = await d.fileBug({
        workspaceId: input.workspaceId,
        signature: t.signature,
        excerpt: label(t),
        title: `[friction] flaky test: ${label(t)} in ${t.job}`.slice(0, 200),
        description: [
          `\`${t.job}\` failed on a PR whose diff touches none of the paths it tests, while the base branch was not failing it.`,
          'buildd re-ran the failed jobs instead of filing a CI-fix attempt. Each later re-run for this test is added below.',
          '',
          ...(t.test ? [`Test: ${t.test}`, ...(t.file ? [`File: ${t.file}`] : []), ''] : []),
          'Make the test deterministic. Until it is, every PR it flakes on waits for a re-run.',
          '',
          'Occurrences:',
          line,
        ].join('\n'),
      });
      if (bug) filed.push({ signature: t.signature, taskId: bug.id, outcome: 'created' });
    } catch (err) {
      console.warn(`[ci-flake] could not file friction for ${t.signature}:`, err);
    }
  }
  return filed;
}

export async function rerunIfKnownFlake(input: FlakeRerunInput, deps?: FlakeRerunDeps, now = new Date()): Promise<FlakeRerunOutcome> {
  try {
    const d = deps ?? await defaultDeps();
    const record = await d.read(input);
    if (!record || record.runId == null) return { rerun: false, reason: 'no_record' };
    const jobs = knownFlakeJobs(record);
    if (!jobs) return { rerun: false, reason: 'not_flake' };
    const runAttempt = record.runAttempt ?? 1;
    if (runAttempt >= MAX_FLAKE_RUN_ATTEMPTS) return { rerun: false, reason: 'attempts_exhausted' };

    await d.rerunFailedJobs(input, record.runId);
    const tests = flakyTestsOf(jobs);
    const friction = await fileFriction(input, record, tests, d, now);
    return { rerun: true, runId: record.runId, runAttempt, tests, friction };
  } catch (err) {
    console.warn(`[ci-flake] flake re-run check failed for ${input.repoFullName}#${input.prNumber}@${input.headSha}:`, err);
    return { rerun: false, reason: 'rerun_failed' };
  }
}

async function defaultDeps(): Promise<FlakeRerunDeps> {
  const [{ readRedChecks, installationGithub }, { githubApi }, { db }, { tasks }, { and, eq, like, notInArray, sql }, { sqlWhere }, { TERMINAL_TASK_STATUSES }] = await Promise.all([
    import('@/lib/red-check-record'),
    import('@/lib/github'),
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
    import('@buildd/core/db/relational-sql'),
    import('@buildd/shared'),
  ]);
  return {
    read: async (input) => {
      const read = await readRedChecks(installationGithub(input.installationId), input.repoFullName, input.headSha, null, undefined, { number: input.prNumber });
      return read === 'unchanged' ? null : read;
    },
    rerunFailedJobs: async (input, runId) => {
      await githubApi(input.installationId, `/repos/${input.repoFullName}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
    },
    findOpenBug: async (workspaceId, signature) => (await db.query.tasks.findFirst({
      where: sqlWhere(and(
        eq(tasks.workspaceId, workspaceId),
        like(tasks.title, '[friction] %'),
        sql`${tasks.context}->>'frictionSignature' = ${signature}`,
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      )),
      columns: { id: true },
    })) ?? null,
    appendToBug: async (taskId, text) => {
      await db.update(tasks).set({ description: sql`coalesce(${tasks.description}, '') || ${text}`, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    },
    fileBug: async (row) => {
      const [inserted] = await db.insert(tasks).values({
        workspaceId: row.workspaceId,
        title: row.title,
        description: row.description,
        priority: 3,
        status: 'pending',
        mode: 'execution',
        taskClass: 'work',
        // System-filed report, like the other CI and schedule friction.
        creationSource: 'webhook',
        category: 'bug',
        context: { frictionSignature: row.signature, frictionExcerpt: row.excerpt },
      }).returning({ id: tasks.id });
      if (inserted?.id) {
        const { wakeTask } = await import('@/lib/dispatch-authority');
        await wakeTask(inserted.id, 'task.created');
      }
      return inserted ?? null;
    },
  };
}
