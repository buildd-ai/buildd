import { db } from '@buildd/core/db';
import { specs, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { taskPrOf } from '@/lib/workflow/task-pr';
import { recordsByRevision } from './criteria';
import { fetchFileAtCommit, linkedRepo } from './repo-source';
import { updateSpecMetadata } from './metadata';

/**
 * The acceptance-tests task's tests, recorded against their checks (Living
 * Specs "checking work against a spec", R-77, AC-123). When the task has
 * finished, the spec's metadata `verified_by` lists the test file of each
 * acceptance check that has a test whose name carries the check's id. Only the
 * metadata block moves: the spec text, version and approved hash do not.
 */

export type TestFile = { path: string; text: string };
export type CheckTests = { byCheck: Map<string, { path: string; name: string }>; untested: string[] };

const TEST_PATH = /(\.test\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests)\//;
export const isTestPath = (p: string) => TEST_PATH.test(p);

const CALL = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** The names of the tests a file declares with `it(...)` or `test(...)`. */
export function testNames(text: string): string[] {
  return [...text.matchAll(CALL)].map((m) => m[2]);
}

const carries = (name: string, id: string) =>
  new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(name);

/** For each check id, the first test whose name contains the id as a whole token. */
export function testsByCheck(checkIds: readonly string[], files: readonly TestFile[]): CheckTests {
  const byCheck = new Map<string, { path: string; name: string }>();
  for (const id of checkIds) {
    for (const f of files) {
      const name = testNames(f.text).find((n) => carries(n, id));
      if (name) { byCheck.set(id, { path: f.path, name }); break; }
    }
  }
  return { byCheck, untested: checkIds.filter((id) => !byCheck.has(id)) };
}

/** The new `verified_by`: what it lists plus the test files found; null when that is no change. A keyed record stays keyed by check id. */
export function verifiedByUpdate(current: string[] | Record<string, string[]> | undefined, found: CheckTests): string[] | Record<string, string[]> | null {
  if (current && !Array.isArray(current)) {
    const next: Record<string, string[]> = { ...current };
    let changed = false;
    for (const [id, t] of found.byCheck) {
      if (!next[id]?.includes(t.path)) { next[id] = [...(next[id] ?? []), t.path]; changed = true; }
    }
    return changed ? next : null;
  }
  const have = current ?? [];
  const next = [...new Set([...have, ...[...found.byCheck.values()].map((t) => t.path)])];
  return next.length === have.length ? null : next;
}

const MAX_TEST_FILES = 40;

/**
 * Record the finished acceptance-tests task's tests in its spec's `verified_by`.
 * Best effort: a task without the marker, a PR GitHub cannot be reached for, or
 * no test found changes nothing.
 */
export async function recordAcceptanceVerifiedBy(taskId: string): Promise<{ recorded: string[] } | { skipped: string }> {
  const [task] = await db.select({ workspaceId: tasks.workspaceId, status: tasks.status, context: tasks.context }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const raw = (task?.context as { acceptanceTests?: unknown } | null)?.acceptanceTests;
  const marker = raw && typeof raw === 'object' ? (raw as { specId?: unknown }) : null;
  if (!task || typeof marker?.specId !== 'string' || !marker.specId) return { skipped: 'not an acceptance-tests task' };
  if (task.status !== 'completed') return { skipped: 'the task has not completed' };
  const pr = await taskPrOf(taskId);
  if (!pr?.prNumber) return { skipped: 'the task has no PR' };
  const repo = await linkedRepo(task.workspaceId);
  if (!repo) return { skipped: 'no linked repo' };

  const [spec] = await db.select().from(specs).where(eq(specs.id, marker.specId)).limit(1);
  if (!spec) return { skipped: 'spec not found' };
  const revision = spec.approvedRevision ?? spec.version;
  const records = (await recordsByRevision({ id: spec.id, bodyArtifactId: spec.bodyArtifactId }, { revisions: [revision] })).get(revision) ?? [];
  const checkIds = records.map((r) => r.criterionId).filter((id) => id.startsWith('AC-'));
  if (!checkIds.length) return { skipped: 'the spec has no acceptance checks' };

  let head: string;
  let paths: string[];
  try {
    const p = await githubApi(repo.installationId, `/repos/${repo.fullName}/pulls/${pr.prNumber}`);
    head = p.head.sha;
    const files = await githubApi(repo.installationId, `/repos/${repo.fullName}/pulls/${pr.prNumber}/files?per_page=100`);
    paths = (files as Array<{ filename: string; status: string }>).filter((f) => f.status !== 'removed' && isTestPath(f.filename)).map((f) => f.filename).slice(0, MAX_TEST_FILES);
  } catch {
    return { skipped: 'GitHub could not be reached' };
  }
  const texts: TestFile[] = [];
  for (const path of paths) {
    const r = await fetchFileAtCommit(repo, path, head);
    if (r.ok) texts.push({ path, text: r.text });
  }
  const found = testsByCheck(checkIds, texts);
  const next = verifiedByUpdate(spec.metadata?.verified_by, found);
  if (!next) return { skipped: 'no new tests to record' };
  const res = await updateSpecMetadata(
    { kind: 'system', label: 'system:acceptance-tests' },
    spec.id,
    { changes: { verified_by: next }, reason: `Acceptance tests added for ${[...found.byCheck.keys()].join(', ')}` },
  );
  return res.ok ? { recorded: [...found.byCheck.keys()] } : { skipped: res.error };
}
