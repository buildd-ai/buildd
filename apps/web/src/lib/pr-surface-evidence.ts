/** Head-bound patches for live PRs; permanent merged evidence written by the close subscriber. */
import { db } from '@buildd/core/db';
import { systemCache } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { eq } from 'drizzle-orm';
import { isRenderedSurfaceChange } from '@buildd/core/surface-audit';
import type { ImpactFile } from './workflow/visual-review-impact';

type Repo = { installationId: number; fullName: string };
type Evidence = { headSha: string; files: ImpactFile[] };
const keyFor = (repo: Repo, pr: number, head: string) =>
  `surface-files:v1:${repo.installationId}:${repo.fullName.toLowerCase()}#${pr}@${head}`;

async function read(key: string): Promise<Evidence | null> {
  try {
    const row = await db.query.systemCache.findFirst({ where: sqlWhere(eq(systemCache.key, key)) });
    if (!row || (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())) return null;
    const value = row.value as Evidence;
    return typeof value?.headSha === 'string' && Array.isArray(value.files)
      && value.files.every(f => typeof f.path === 'string' && (f.patch === null || typeof f.patch === 'string')) ? value : null;
  } catch { return null; }
}

async function write(key: string, value: Evidence, permanent: boolean): Promise<void> {
  const updatedAt = new Date();
  const expiresAt = permanent ? null : new Date(Date.now() + 30 * 86400_000);
  await db.insert(systemCache).values({ key, value, updatedAt, expiresAt })
    .onConflictDoUpdate({ target: systemCache.key, set: { value, updatedAt, expiresAt } });
}

async function current(repo: Repo, pr: number): Promise<{ head: { sha: string }; merged: boolean }> {
  const { githubApi } = await import('@/lib/github');
  const result = await githubApi(repo.installationId, `/repos/${repo.fullName}/pulls/${pr}`) as { head?: { sha?: string }; merged?: boolean };
  if (!result?.head?.sha || typeof result.merged !== 'boolean') throw new Error('PR head unavailable');
  return result as { head: { sha: string }; merged: boolean };
}

async function changedFiles(repo: Repo, pr: number): Promise<ImpactFile[] | null> {
  const { githubApi } = await import('@/lib/github');
  const out: ImpactFile[] = [];
  for (let page = 1; page <= 3; page++) {
    const files = await githubApi(repo.installationId, `/repos/${repo.fullName}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) return null;
    for (const f of files as Array<{ filename?: string; previous_filename?: string; patch?: string }>) {
      if (!f.filename) return null;
      if (isRenderedSurfaceChange(f.filename)) out.push({ path: f.filename, patch: f.patch ?? null });
      if (f.previous_filename && isRenderedSurfaceChange(f.previous_filename)) out.push({ path: f.previous_filename, patch: null });
    }
    if (files.length < 100) return out;
  }
  // A capped list is not evidence of absence. Let the caller use declared scope.
  return null;
}

/** Rendering never fills merged evidence, even on cold/expired/unavailable storage. */
export async function loadPrSurfaceFiles(repo: Repo, pr: number, knownMerged = false): Promise<ImpactFile[] | null> {
  const mergedKey = keyFor(repo, pr, 'merged');
  const durable = await read(mergedKey);
  if (durable) return durable.files;
  if (knownMerged) return null;
  const before = await current(repo, pr);
  if (before.merged) return null;
  const key = keyFor(repo, pr, before.head.sha);
  const hit = await read(key);
  if (hit?.headSha === before.head.sha) return hit.files;
  const files = await changedFiles(repo, pr);
  if (!files) return null;
  // GitHub's files endpoint is mutable: never label a racing response with an older SHA.
  const after = await current(repo, pr);
  if (after.head.sha !== before.head.sha || after.merged) return null;
  try { await write(key, { headSha: before.head.sha, files }, false); }
  catch (err) { console.warn('[surface-evidence] open evidence write failed:', err); }
  return files;
}

/** Idempotent merge-event writer. Kept outside every rendering/read path. */
export async function persistMergedSurfaceEvidence(repo: Repo, pr: number): Promise<void> {
  const key = keyFor(repo, pr, 'merged');
  if (await read(key)) return;
  const state = await current(repo, pr);
  if (!state.merged) return;
  const files = await changedFiles(repo, pr);
  if (!files) return;
  await write(key, { headSha: state.head.sha, files }, true);
}
