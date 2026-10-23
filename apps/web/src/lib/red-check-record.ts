/**
 * The stored reading of a PR's red head (`context.redChecks` on the tasks that
 * own the PR), so Home can name the failing check and its cause without
 * calling GitHub on render (surface-ia §11, R-1 to R-4).
 *
 * Written from the CI-failure path for every red head, and by the Re-run
 * action (`/api/prs/[prNumber]/rerun-ci`) for who re-ran what. Best-effort by
 * contract: a GitHub or database failure leaves the card on its plain words
 * and never costs the PR its retry.
 *
 * GitHub reads are injectable so the logic is testable without the network.
 */
import { inflateRawSync } from 'zlib';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { inArray, sql } from 'drizzle-orm';
import { githubApi, githubApiText, getInstallationToken } from '@/lib/github';
import { workerOwnsPr } from '@/lib/repo-scope';
import {
  failingLines, testReportFailures, firstTestName, foldSummaryGates, classifyJob, causeOf, signatureOf,
  mergeRedRecord, parseRedRecord, type RedCheckRecord, type RedJob, type RedRerun,
} from '@/lib/red-check-cause';

/** The key on `tasks.context`. */
export const RED_CHECKS_KEY = 'redChecks';
/** Failed jobs whose logs are read; the card names at most this many. */
const MAX_JOBS = 3;
/** Re-runs kept per head: enough to say "failed twice", not a log. */
const MAX_RERUNS = 5;
/** A test report bigger than this is not read: the card needs a test name, not the report. */
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

export interface RedCheckGithub {
  json(path: string): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  text(path: string): Promise<string>;
  /** Raw bytes of an artifact zip; null when it cannot be downloaded. */
  bytes(path: string): Promise<Uint8Array | null>;
}

export function installationGithub(installationId: number): RedCheckGithub {
  return {
    json: path => githubApi(installationId, path),
    text: path => githubApiText(installationId, path),
    async bytes(path) {
      const token = await getInstallationToken(installationId);
      // GitHub answers with a redirect to blob storage; fetch drops the
      // Authorization header on that cross-origin hop, as it must.
      const res = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_REPORT_BYTES) return null;
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * The first file in a zip archive, as text. Enough for an Actions artifact
 * holding one report file; null for anything it cannot read.
 */
export function unzipFirstText(zip: Uint8Array): string | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cd = view.getUint32(eocd + 16, true);
  if (cd + 46 > zip.length || view.getUint32(cd, true) !== 0x02014b50) return null;
  const method = view.getUint16(cd + 10, true);
  const size = view.getUint32(cd + 20, true);
  const local = view.getUint32(cd + 42, true);
  if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50) return null;
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = zip.subarray(start, start + size);
  try {
    if (method === 0) return Buffer.from(data).toString('utf8');
    if (method === 8) return inflateRawSync(data).toString('utf8');
  } catch {
    return null;
  }
  return null;
}

/**
 * The unit-test report a job uploads (`.github/workflows/build.yml`):
 * `unit-test-report-windows` for the Windows runner job, `unit-test-report-<n>`
 * for shard n of the Linux unit tests.
 */
export function reportArtifactFor(jobName: string, artifacts: ReadonlyArray<{ id: number; name: string; expired?: boolean }>): number | null {
  const live = artifacts.filter(a => !a.expired && a.name.startsWith('unit-test-report-'));
  const shard = jobName.match(/\((\d+)\/\d+\)/)?.[1];
  const want = /windows/i.test(jobName) ? 'unit-test-report-windows' : shard ? `unit-test-report-${shard}` : null;
  return live.find(a => a.name === want)?.id ?? null;
}

interface GithubJob { id?: number; name?: string; conclusion?: string; steps?: Array<{ name?: string; conclusion?: string }> }

/**
 * Read the latest failed run on `headSha`: its failed jobs, summary gates
 * folded, each with its failing lines and rule. Null when there is no failed
 * run. `known` short-cuts a run already read at the same attempt.
 */
export async function readRedChecks(
  gh: RedCheckGithub,
  repoFullName: string,
  headSha: string,
  known?: Pick<RedCheckRecord, 'runId' | 'runAttempt'> | null,
  now = () => new Date(),
): Promise<RedCheckRecord | 'unchanged' | null> {
  const runs = await gh.json(`/repos/${repoFullName}/actions/runs?head_sha=${headSha}&status=failure`);
  const run = runs?.workflow_runs?.[0];
  if (typeof run?.id !== 'number') return null;
  const runAttempt = typeof run.run_attempt === 'number' ? run.run_attempt : 1;
  if (known && known.runId === run.id && known.runAttempt === runAttempt) return 'unchanged';

  const data = await gh.json(`/repos/${repoFullName}/actions/runs/${run.id}/jobs`);
  const failed = ((data?.jobs ?? []) as GithubJob[])
    .filter(j => (j.conclusion === 'failure' || j.conclusion === 'timed_out') && typeof j.name === 'string' && typeof j.id === 'number')
    .map(j => ({ id: j.id!, name: j.name!, step: j.steps?.find(s => s.conclusion === 'failure' && typeof s.name === 'string')?.name ?? null }));
  const named = foldSummaryGates(failed).slice(0, MAX_JOBS);

  let artifacts: Array<{ id: number; name: string; expired?: boolean }> | null = null;
  const jobs: RedJob[] = [];
  for (const job of named) {
    const log = await gh.text(`/repos/${repoFullName}/actions/jobs/${job.id}/logs`).catch(() => null);
    let lines = failingLines(log);
    // The log names no test (a killed or timed-out run): read the job's own report.
    if (!firstTestName(lines)) {
      artifacts ??= await gh.json(`/repos/${repoFullName}/actions/runs/${run.id}/artifacts`).then(a => a?.artifacts ?? []).catch(() => []);
      const id = reportArtifactFor(job.name, artifacts!);
      const zip = id != null ? await gh.bytes(`/repos/${repoFullName}/actions/artifacts/${id}/zip`).catch(() => null) : null;
      const report = zip ? testReportFailures(unzipFirstText(zip)) : null;
      if (report) lines = [report, lines].filter(Boolean).join('\n');
    }
    jobs.push({ name: job.name, step: job.step, lines, rule: classifyJob(log, lines) });
  }
  return {
    headSha, runId: run.id, runAttempt, at: now().toISOString(),
    jobs, cause: causeOf(jobs), signature: signatureOf(jobs),
  };
}

/** The tasks that own a PR: every worker row stamped with it. */
function ownerTaskIds(repoFullName: string, prNumber: number) {
  return db.select({ id: workers.taskId }).from(workers).where(workerOwnsPr(repoFullName, prNumber));
}

export async function loadRedRecord(repoFullName: string, prNumber: number): Promise<RedCheckRecord | null> {
  const rows = await db
    .select({ value: sql<unknown>`${tasks.context}->${RED_CHECKS_KEY}` })
    .from(tasks)
    .where(inArray(tasks.id, ownerTaskIds(repoFullName, prNumber)));
  const records = rows.map(r => parseRedRecord(r.value)).filter((r): r is RedCheckRecord => !!r);
  return records.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

async function saveRedRecord(repoFullName: string, prNumber: number, record: RedCheckRecord): Promise<void> {
  await db
    .update(tasks)
    .set({ context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), ${`{${RED_CHECKS_KEY}}`}::text[], ${JSON.stringify(record)}::jsonb)` })
    .where(inArray(tasks.id, ownerTaskIds(repoFullName, prNumber)));
}

/**
 * Read and store the red head's record. Never throws. Re-reading a run at the
 * attempt already stored costs one request and writes nothing.
 */
export async function recordRedChecks(input: { installationId: number; repoFullName: string; prNumber: number; headSha: string }, gh: RedCheckGithub = installationGithub(input.installationId)): Promise<RedCheckRecord | null> {
  try {
    const prev = await loadRedRecord(input.repoFullName, input.prNumber);
    const read = await readRedChecks(gh, input.repoFullName, input.headSha, prev?.headSha === input.headSha ? prev : null);
    if (read === 'unchanged') return prev;
    if (!read) return null;
    const record = mergeRedRecord(prev, read);
    await saveRedRecord(input.repoFullName, input.prNumber, record);
    return record;
  } catch (err) {
    console.warn(`[red-checks] could not record ${input.repoFullName}#${input.prNumber}@${input.headSha}:`, err);
    return null;
  }
}

/**
 * Record a re-run a person asked for (R-4): who, when, which run, and the
 * failure it was meant to clear. The next reading of the same head compares
 * against it.
 */
export async function recordRedRerun(input: { repoFullName: string; prNumber: number; headSha: string; runId: number; by: string }, now = () => new Date()): Promise<RedCheckRecord | null> {
  const prev = await loadRedRecord(input.repoFullName, input.prNumber);
  const base: RedCheckRecord = prev?.headSha === input.headSha
    ? prev
    : { headSha: input.headSha, runId: input.runId, runAttempt: null, at: now().toISOString(), jobs: [], cause: 'unknown', signature: '' };
  const rerun: RedRerun = { at: now().toISOString(), by: input.by, runId: input.runId, signature: base.signature };
  const record: RedCheckRecord = { ...base, reruns: [...(base.reruns ?? []), rerun].slice(-MAX_RERUNS) };
  await saveRedRecord(input.repoFullName, input.prNumber, record);
  return record;
}
