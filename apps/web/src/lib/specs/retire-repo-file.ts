import { db } from '@buildd/core/db';
import { specMetadataChanges, specs } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { specShortId, verifyRepoCopy } from '@buildd/spec-contract/repo-copy';
import { buildSpecIndex, markSpecSuperseded, parseSpecFrontmatter, SPEC_META_FILES, type IndexedSpec } from '@buildd/spec-contract/repo-spec';
import { checkSuitesAllPassed, type CheckSuiteSummary } from '@/lib/github';
import { appBaseUrl } from '@/lib/app-url';
import { defaultRepoCopyDeps, GENERATED_SPEC_COPY_EXCEPTION, mergeGeneratedSpecPr, readRepoState, type RepoCopyDeps } from './repo-copy';

/**
 * A retired spec's repo file (docs/specs/living-specs.md §22, R-78 to R-80).
 *
 * When a spec is retired or superseded and a file in `docs/specs/` stands for
 * it, buildd opens one PR on it. An imported spec's source file gets
 * `status: superseded` and `superseded_by` in its frontmatter, its body left as
 * is (`markSpecSuperseded`): an ordinary PR a person merges. A generated copy
 * (§18) is removed and INDEX.md rebuilt: that PR lands on green CI under the
 * generated-copy exception (R-35), only at the head buildd wrote.
 *
 * `superseded_by` is the replacement's slug when it has a file in the repo,
 * `buildd:<short id>` when it lives only in buildd, and `none` when nothing
 * replaces it (SPEC-FORMAT.md). A file that already reads superseded, or is no
 * longer in the repo, gets no PR.
 *
 * Record: no new column. The outcome is `repoFile` on the retirement's own
 * `spec_metadata_changes` row, so the spec page names the PR until it merges
 * and, after a restore (R-80), says the repo file still reads superseded. A row
 * that has one is never written again, so a retirement opens at most one PR.
 */

export interface RetirementRepoFile {
  /** `source`: the file the spec was imported from; `copy`: its generated copy (§18). */
  kind: 'source' | 'copy';
  path: string;
  /** `open`/`merged`/`closed`: the PR's; `already`: the file read superseded, no PR; `removed`: it is not in the repo; `failed`: nothing was opened. */
  state: 'open' | 'merged' | 'closed' | 'already' | 'removed' | 'failed';
  repoFullName?: string;
  prNumber?: number;
  branch?: string;
  /** The commit buildd wrote: a copy removal lands under the exception only at this head. */
  headSha?: string;
  /** Retired by confirming an import run (R-79): the repo already said so. */
  via?: 'import';
  error?: string;
  at: string;
}

const SPECS_DIR = 'docs/specs/';
const RETIRED = ['retired', 'superseded'];
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** The newest status row that retired the spec (restores excluded). */
export async function retirementRow(specId: string) {
  const [row] = await db.select().from(specMetadataChanges)
    .where(and(eq(specMetadataChanges.specId, specId), eq(specMetadataChanges.field, 'status'), sql`${specMetadataChanges.newValue}->>'status' IN ('retired', 'superseded')`))
    .orderBy(desc(specMetadataChanges.createdAt)).limit(1);
  return row ?? null;
}

export const repoFileOf = (newValue: unknown): RetirementRepoFile | null =>
  ((newValue as { repoFile?: RetirementRepoFile } | null)?.repoFile ?? null);

async function record(changeId: string, repoFile: RetirementRepoFile): Promise<RetirementRepoFile> {
  await db.execute(sql`UPDATE spec_metadata_changes SET new_value = coalesce(new_value, '{}'::jsonb) || jsonb_build_object('repoFile', ${JSON.stringify(repoFile)}::jsonb) WHERE id = ${changeId}::uuid`);
  return repoFile;
}

/** INDEX.md over a docs/specs listing, when the repo has one and it would change. */
function indexFile(files: Map<string, string>): { path: string; content: string } | null {
  const old = files.get('INDEX.md');
  if (old === undefined) return null;
  const indexed: IndexedSpec[] = [...files.keys()].filter((f) => !SPEC_META_FILES.has(f)).sort().map((file) => ({
    file, slug: file.replace(/\.md$/, ''), fm: parseSpecFrontmatter(files.get(file)!).fm ?? {},
  }));
  const content = buildSpecIndex(indexed);
  return old.trim() === content.trim() ? null : { path: `${SPECS_DIR}INDEX.md`, content };
}

/** What `superseded_by` says: the replacement's slug when its file is in the repo, else its short id, else `none`. */
async function supersededByValue(replacementId: unknown, files: Map<string, string>, self: string): Promise<{ value: string; title: string | null }> {
  if (typeof replacementId !== 'string') return { value: 'none', title: null };
  const [r] = await db.select({ id: specs.id, title: specs.title, repoSource: specs.repoSource, repoCopy: specs.repoCopy }).from(specs).where(eq(specs.id, replacementId)).limit(1);
  if (!r) return { value: 'none', title: null };
  const p = r.repoCopy?.path ?? r.repoSource?.path;
  if (p && p !== self && p.startsWith(SPECS_DIR) && files.has(p.slice(SPECS_DIR.length))) return { value: p.slice(SPECS_DIR.length).replace(/\.md$/, ''), title: r.title };
  return { value: `buildd:${specShortId(r.id)}`, title: r.title };
}

/**
 * Open the one PR for a retired spec's repo file (R-78), after the retirement
 * committed. Nothing when no file stands for the spec, when it is live again,
 * or when its retirement already has a `repoFile`. Never throws: the outcome
 * is recorded on the retirement row and returned.
 */
export async function openRetirementPr(specId: string, deps: RepoCopyDeps = defaultRepoCopyDeps): Promise<RetirementRepoFile | null> {
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !RETIRED.includes(spec.status)) return null;
  const row = await retirementRow(spec.id);
  if (!row) return null;
  const prior = repoFileOf(row.newValue);
  if (prior) return prior;
  const path = spec.repoCopy?.path ?? spec.repoSource?.path;
  if (!path || !path.startsWith(SPECS_DIR)) return null;
  const at = deps.now().toISOString();
  let kind: RetirementRepoFile['kind'] = spec.repoCopy?.path ? 'copy' : 'source';
  try {
    const repo = await readRepoState(spec.workspaceId, deps);
    if ('error' in repo) return record(row.id, { kind, path, state: 'failed', error: repo.error, at });
    const name = path.slice(SPECS_DIR.length);
    const text = repo.specFiles.get(name);
    if (text === undefined) return record(row.id, { kind, path, state: 'removed', at });
    kind = (await verifyRepoCopy(text)).generated ? 'copy' : 'source';
    const short = specShortId(spec.id);
    const link = `${appBaseUrl()}/app/specs/${short}`;
    const next = new Map(repo.specFiles);
    let tree: Array<Record<string, unknown>>;
    let title: string;
    let summary: string[];
    if (kind === 'copy') {
      next.delete(name);
      tree = [{ path, mode: '100644', type: 'blob', sha: null }];
      title = `docs(specs): remove the generated copy ${name}`;
      summary = [
        `Spec ${short} was ${spec.status} in buildd (${link}), so its generated copy \`${path}\` goes and the index is rebuilt.`,
        '',
        `Generated by buildd. This PR lands on green CI with no review, because retiring the spec was the decision (merge-policy exception \`${GENERATED_SPEC_COPY_EXCEPTION}\`). A commit not written by buildd voids that.`,
      ];
    } else {
      if (parseSpecFrontmatter(text).fm?.status === 'superseded') return record(row.id, { kind, path, state: 'already', at });
      const by = await supersededByValue((row.newValue as { supersededBy?: unknown } | null)?.supersededBy, repo.specFiles, path);
      const marked = markSpecSuperseded(text, by.value);
      if (!marked) return record(row.id, { kind, path, state: 'failed', error: 'the file has no frontmatter block to mark superseded', at });
      next.set(name, marked);
      tree = [{ path, mode: '100644', type: 'blob', content: marked }];
      title = `docs(specs): mark ${name} superseded`;
      summary = [
        `Spec ${short} was ${spec.status} in buildd${by.title ? `, replaced by ${by.title}` : ''} (${link}).`,
        '',
        `This sets \`status: superseded\` and \`superseded_by: ${by.value}\` in the frontmatter of \`${path}\`. The body is unchanged. Nothing changes in the repo until a person merges this PR.`,
      ];
    }
    const index = indexFile(next);
    if (index) tree.push({ path: index.path, mode: '100644', type: 'blob', content: index.content });
    const { api } = deps;
    const t = await api(repo.installationId, `/repos/${repo.fullName}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: repo.baseTreeSha, tree }) });
    const commit = await api(repo.installationId, `/repos/${repo.fullName}/git/commits`, {
      method: 'POST', body: JSON.stringify({ message: `${title} (spec ${short} ${spec.status})`, tree: t?.sha, parents: [repo.baseSha] }),
    });
    const headSha: string | undefined = commit?.sha;
    if (!headSha) throw new Error('the retirement commit was not created');
    const branch = `buildd/spec-retire-${short}`;
    try {
      await api(repo.installationId, `/repos/${repo.fullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'PATCH', body: JSON.stringify({ sha: headSha, force: true }) });
    } catch (err) {
      if (!/\b(404|422)\b/.test(errMsg(err))) throw err;
      await api(repo.installationId, `/repos/${repo.fullName}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }) });
    }
    const body = [...summary, '', `Files: ${tree.map((f) => `\`${f.path}\``).join(', ')}`].join('\n');
    const [owner] = repo.fullName.split('/');
    const open = await api(repo.installationId, `/repos/${repo.fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`).catch(() => []);
    let prNumber: number | undefined = Array.isArray(open) && open[0]?.number ? open[0].number : undefined;
    if (prNumber) await api(repo.installationId, `/repos/${repo.fullName}/pulls/${prNumber}`, { method: 'PATCH', body: JSON.stringify({ title, body }) });
    else prNumber = (await api(repo.installationId, `/repos/${repo.fullName}/pulls`, { method: 'POST', body: JSON.stringify({ title, head: branch, base: repo.base, body }) }))?.number;
    return record(row.id, { kind, path, state: 'open', repoFullName: repo.fullName, prNumber, branch, headSha, at });
  } catch (err) {
    return record(row.id, { kind, path, state: 'failed', error: errMsg(err), at });
  }
}

/** The retirement row a PR belongs to, or null. */
async function rowForPr(repoFullName: string, prNumber: number) {
  const [row] = await db.select().from(specMetadataChanges)
    .where(and(eq(specMetadataChanges.field, 'status'), sql`${specMetadataChanges.newValue}->'repoFile'->>'repoFullName' = ${repoFullName}`, sql`${specMetadataChanges.newValue}->'repoFile'->>'prNumber' = ${String(prNumber)}`))
    .orderBy(desc(specMetadataChanges.createdAt)).limit(1);
  return row ?? null;
}

/**
 * CI finished on a PR. When it is a retirement's generated-copy removal, land
 * it under the exception (R-35): green, open, and its head the commit buildd
 * wrote. A source-file PR is never landed here: a person merges it. Null when
 * the PR is not a copy removal of a retirement.
 */
export async function landRetirementPr(
  e: { repoFullName: string; prNumber: number; headSha: string; conclusion: string | null; installationId: number },
  deps: Pick<RepoCopyDeps, 'api'> = defaultRepoCopyDeps,
): Promise<{ specId: string; outcome: 'merged' | 'refused' | 'behind' | 'waiting' | 'stale' } | null> {
  const row = await rowForPr(e.repoFullName, e.prNumber);
  const rf = row ? repoFileOf(row.newValue) : null;
  if (!row || !rf || rf.kind !== 'copy' || rf.state !== 'open') return null;
  const specId = row.specId;
  const pr = await deps.api(e.installationId, `/repos/${e.repoFullName}/pulls/${e.prNumber}`);
  const liveHead: string | undefined = pr?.head?.sha;
  if (pr?.state !== 'open' || liveHead !== e.headSha) return { specId, outcome: 'stale' };
  if (liveHead !== rf.headSha) return { specId, outcome: 'refused' };
  if (e.conclusion !== 'success') return { specId, outcome: e.conclusion === null ? 'waiting' : 'behind' };
  const suites = await deps.api(e.installationId, `/repos/${e.repoFullName}/commits/${liveHead}/check-suites`).catch(() => null);
  if (!checkSuitesAllPassed((suites?.check_suites ?? []) as CheckSuiteSummary[])) return { specId, outcome: 'waiting' };
  try {
    await mergeGeneratedSpecPr(deps, e, liveHead);
  } catch (err) {
    console.warn(`[spec-retire] ${e.repoFullName}#${e.prNumber}: merge refused: ${errMsg(err)}`);
    return { specId, outcome: 'behind' };
  }
  await record(row.id, { ...rf, state: 'merged' });
  return { specId, outcome: 'merged' };
}

/** A PR closed on GitHub: a retirement's open PR is now merged or closed. Returns the rows it settled. */
export async function settleRetirementPr(e: { repoFullName: string; prNumber: number; merged: boolean }): Promise<number> {
  const res = await db.execute(sql`
    UPDATE spec_metadata_changes SET new_value = jsonb_set(new_value, '{repoFile,state}', to_jsonb(${e.merged ? 'merged' : 'closed'}::text))
    WHERE field = 'status' AND new_value->'repoFile'->>'repoFullName' = ${e.repoFullName}
      AND new_value->'repoFile'->>'prNumber' = ${String(e.prNumber)} AND new_value->'repoFile'->>'state' = 'open'
    RETURNING id`);
  return ((res as { rows?: unknown[] }).rows ?? []).length;
}

const prHref = (rf: RetirementRepoFile) => (rf.repoFullName && rf.prNumber ? `https://github.com/${rf.repoFullName}/pull/${rf.prNumber}` : null);

/** The page's line for a retired spec while its PR is open (R-78); null once it merges or when there is none. */
export function retiredRepoLine(rf: RetirementRepoFile | null): { text: string; href: string | null } | null {
  if (!rf || rf.state !== 'open' || !rf.prNumber) return null;
  return {
    text: rf.kind === 'copy' ? `PR #${rf.prNumber} removes the repo copy ${rf.path}.` : `PR #${rf.prNumber} marks ${rf.path} superseded in the repo. It lands when a person merges it.`,
    href: prHref(rf),
  };
}

/** The page's note on a restored spec whose retirement reached its repo file (R-80): restoring changed nothing there. */
export function restoredRepoNote(rf: RetirementRepoFile | null): string | null {
  if (!rf) return null;
  if (rf.kind === 'copy' && (rf.state === 'open' || rf.state === 'merged')) {
    return `The repo copy ${rf.path} was removed${rf.prNumber ? ` by PR #${rf.prNumber}` : ''}; restoring does not write it back.`;
  }
  if (rf.state === 'removed') return `${rf.path} is no longer in the repo; restoring does not recreate it.`;
  if (rf.state === 'open') return `${rf.path} still reads superseded once PR #${rf.prNumber} merges: restoring does not edit the repo file. Close the PR to leave the file as it was.`;
  if (rf.state === 'merged' || rf.state === 'already') return `${rf.path} still reads superseded: restoring does not edit the repo file.`;
  return null;
}
