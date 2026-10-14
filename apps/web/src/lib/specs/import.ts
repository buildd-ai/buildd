import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { specRevisions, specs, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { githubApi } from '@/lib/github';
import { appBaseUrl } from '@/lib/app-url';
import { requestingPerson } from '@/lib/request-person';
import { repoSpecForImport } from '@buildd/spec-contract/repo-import';
import type { SpecMetadata } from '@buildd/spec-contract/repo-copy';
import type { DuplicateCheckDeps } from '@/lib/spec-duplicate-decision';
import type { DuplicateCandidate } from './duplicates';
import { linkedRepo } from './repo-source';
import { areaDomain } from './repo-copy';
import { AREA_GONE_STATUSES, AREA_SCOPES, CROSS_CUTTING_DOMAINS, listAreas, type AreaClassification, type AreaClassifier, type AreaInfo } from './areas';
import { specCard } from './card';
import { insertFiling, setParentIfUnfiled } from './filings';
import { author, createSpecDraft, fail, reach, reviseSpecDraft, type SpecCaller, type SpecError, type SpecRow } from './store';
import { approveSpecRevision, specApprovalDeps, specApprover } from './approval';
import { FILE_METADATA_KEYS, updateSpecMetadata } from './metadata';

/**
 * Import a workspace's repo spec files as native specs (docs/specs/living-specs.md
 * §18, R-18, R-19, native spec R-35).
 *
 * Import reads `docs/specs/*.md` at one commit of the workspace's linked repo,
 * through its GitHub App installation (never a local checkout), and for each
 * file says what it would create: the spec (title, body, scope `feature`),
 * where it would be filed, its provenance (path, commit, blob, the PR that
 * last changed it) and any duplicate of an approved spec. A dry run (the
 * default) writes nothing. A real run creates each spec with revision 1
 * marked imported, not approved, and its mechanical frontmatter in the
 * metadata block. It is idempotent: a file whose blob is unchanged is
 * skipped, and a changed one becomes a new imported revision of the same spec.
 * A duplicate is reported in the dry run and skipped on import unless the
 * caller names its path in `allowDuplicates`.
 *
 * Placement goes through the area classifier (§17, `buildd.spec_area`), with
 * every area of the workspace and, as a hint in its input, the file's
 * `domain:` and the domains each area declares. A confident answer (the
 * measured bar) files the spec; any other answer leaves it Unfiled with the
 * suggestion recorded and shown. Only when the classifier does not run (no
 * key, unmeasured model, no areas, an error) is the declared-domain mapping
 * used, labelled as that fallback.
 *
 * A file is `exists` only when it is the same spec: a native spec that
 * recorded the path as its provenance, or one with exactly its title, any
 * case. `attachProvenance` records the path and commit on that spec's metadata
 * block instead (no revision). A native spec that merely cites the path in its
 * repoRefs is a `related` hint: the file is still a create, unless a person
 * names that spec in `attachTo: { <path>: <specId> }`, never automatically.
 *
 * It runs in pages (`limit`, default 15, at most 40, and `cursor`): files in
 * path order, every page read at the commit the first page resolved, which the
 * cursor carries. Files are worked IMPORT_CONCURRENCY at a time, and no new
 * file starts once the page has run IMPORT_PAGE_BUDGET_MS: the page is then
 * cut short and `nextCursor` continues it, so one request stays inside the
 * serverless limit however slow the classifier is, and each page is
 * idempotent on its own.
 *
 * Until a person confirms it the repo file stays the source: no revise in
 * buildd, no approval outside confirmation, no generated copy (store.ts,
 * approval.ts, repo-copy.ts). Confirmation is a person's one act over a batch:
 * each spec is approved only while its file is unchanged since the imported
 * commit, else it is reported stale and stays imported. An agent run or API
 * key is refused; an OAuth session gets the link to the specs page, where
 * the person confirms.
 */

type Api = (installationId: number, path: string, init?: RequestInit) => Promise<any>;
export interface ImportDeps {
  api: Api;
  repo: (workspaceId: string) => Promise<{ fullName: string; installationId: number } | null>;
  now: () => Date;
  /** The duplicate check's own deps; false skips it (tests). */
  duplicates?: DuplicateCheckDeps | false;
  /** The area classifier; default the decisions module's, through modules.ts. */
  classify?: AreaClassifier;
  /** Milliseconds for the page's time bound; default Date.now. */
  clock?: () => number;
  /** No new file starts after this long into the page; default IMPORT_PAGE_BUDGET_MS. */
  pageBudgetMs?: number;
}
export const defaultImportDeps: ImportDeps = { api: githubApi, repo: linkedRepo, now: () => new Date() };

const SPECS_DIR = 'docs/specs';
/** Files history is asked for per GraphQL request. */
const HISTORY_CHUNK = 40;
export const MAX_IMPORT_FILES = 300;
export const DEFAULT_IMPORT_PAGE = 15;
export const MAX_IMPORT_PAGE = 40;
/** Files worked at once: each may make a classifier call and a duplicate check. */
export const IMPORT_CONCURRENCY = 4;
/** After this, no new file starts; the ones in flight finish, so a page ends in about 40 seconds. */
export const IMPORT_PAGE_BUDGET_MS = 25_000;

/** Where the next page starts: the commit every page reads and the last path the previous page covered. */
interface ImportCursor { c: string; a: string }
export function encodeImportCursor(c: ImportCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, c: c.c, a: c.a })).toString('base64url');
}
export function decodeImportCursor(raw: unknown): ImportCursor | null {
  if (typeof raw !== 'string' || raw.length > 600) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: unknown; c?: unknown; a?: unknown };
    if (v?.v !== 1 || typeof v.c !== 'string' || !/^[0-9a-f]{40}$/.test(v.c) || typeof v.a !== 'string' || !v.a.startsWith(`${SPECS_DIR}/`)) return null;
    return { c: v.c, a: v.a };
  } catch {
    return null;
  }
}

export interface RepoSpecFile { path: string; name: string; text: string; blobSha: string }

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** The commit a ref names: the workspace's default branch head when none is given. */
async function resolveCommit(workspaceId: string, repo: { fullName: string; installationId: number }, ref: string | undefined, deps: ImportDeps): Promise<string> {
  let name = ref;
  if (!name) {
    const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const configured = (ws?.gitConfig as { defaultBranch?: unknown } | null)?.defaultBranch;
    name = (typeof configured === 'string' && configured) || (await deps.api(repo.installationId, `/repos/${repo.fullName}`))?.default_branch || 'main';
  }
  const c = await deps.api(repo.installationId, `/repos/${repo.fullName}/commits/${encodeURIComponent(name!)}`);
  const sha = typeof c?.sha === 'string' ? c.sha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve ${name} to a commit`);
  return sha;
}

/** docs/specs/*.md at a commit, with each file's blob id. */
async function readSpecDir(repo: { fullName: string; installationId: number }, commitSha: string, deps: ImportDeps): Promise<RepoSpecFile[]> {
  const [owner, name] = repo.fullName.split('/');
  const gql = await deps.api(repo.installationId, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!, $specs: String!) {
        repository(owner: $owner, name: $name) {
          specs: object(expression: $specs) { ... on Tree { entries { name type oid object { ... on Blob { text } } } } }
        }
      }`,
      variables: { owner, name, specs: `${commitSha}:${SPECS_DIR}` },
    }),
  });
  const out: RepoSpecFile[] = [];
  for (const e of gql?.data?.repository?.specs?.entries ?? []) {
    if (e?.type !== 'blob' || typeof e.name !== 'string' || !e.name.endsWith('.md') || typeof e.oid !== 'string') continue;
    out.push({ path: `${SPECS_DIR}/${e.name}`, name: e.name, text: typeof e.object?.text === 'string' ? e.object.text : '', blobSha: e.oid });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_IMPORT_FILES);
}

/** The PR that last merged a change to each path, as of the commit: one GraphQL request per chunk of files. */
async function lastPrs(repo: { fullName: string; installationId: number }, commitSha: string, paths: readonly string[], deps: ImportDeps): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const [owner, name] = repo.fullName.split('/');
  for (let i = 0; i < paths.length; i += HISTORY_CHUNK) {
    const chunk = paths.slice(i, i + HISTORY_CHUNK);
    const fields = chunk.map((p, j) => `f${j}: history(first: 1, path: ${JSON.stringify(p)}) { nodes { oid associatedPullRequests(first: 3) { nodes { number merged } } } }`).join('\n');
    try {
      const gql = await deps.api(repo.installationId, '/graphql', {
        method: 'POST',
        body: JSON.stringify({
          query: `query($owner: String!, $name: String!, $oid: GitObjectID!) { repository(owner: $owner, name: $name) { commit: object(oid: $oid) { ... on Commit { ${fields} } } } }`,
          variables: { owner, name, oid: commitSha },
        }),
      });
      const commit = gql?.data?.repository?.commit ?? {};
      chunk.forEach((p, j) => {
        const prs = (commit[`f${j}`]?.nodes?.[0]?.associatedPullRequests?.nodes ?? []) as Array<{ number?: number; merged?: boolean }>;
        const pr = prs.find((x) => x.merged) ?? prs[0];
        out.set(p, typeof pr?.number === 'number' ? pr.number : null);
      });
    } catch (err) {
      // Provenance without the PR beats no import: the path, commit and blob still pin the file.
      console.warn('[spec-import] last PR lookup failed:', errMsg(err));
      for (const p of chunk) out.set(p, null);
    }
  }
  return out;
}

// ── Import ──────────────────────────────────────────────────────────────────

export type ImportAction = 'create' | 'reimport' | 'exists' | 'skip';
export type ImportSkip = 'meta_file' | 'not_a_spec_file' | 'superseded' | 'generated_copy' | 'no_title' | 'too_large' | 'already_imported' | 'confirmed' | 'duplicate' | 'failed';

export interface ImportFileRow {
  path: string;
  action: ImportAction;
  reason?: ImportSkip;
  message?: string;
  /** What it would create (or the new revision a re-import writes). */
  spec?: { title: string; scope: 'feature'; body: string };
  /** The existing spec (re-import, already imported), or the one created. */
  specId?: string;
  /** The revision written by a real run. */
  revision?: number;
  /** `exists`: the spec already in buildd this file is, and how it was recognised (`named`: by `attachTo`). */
  existing?: { specId: string; title: string; url: string; matchedBy: 'provenance' | 'title' | 'named' };
  /** Native specs that cite this path in their repoRefs: not this spec, but `attachTo` may name one. */
  related?: Array<{ specId: string; title: string; url: string }>;
  /** `exists` with attachProvenance on a real run: the path and commit are on that spec's metadata block. */
  provenanceAttached?: boolean;
  /**
   * Where it is filed: an area the classifier answered confidently, by the
   * declared-domain fallback (an existing area or one its `domain:` would
   * name), the area a re-imported spec is already under, or nothing (Unfiled).
   */
  area: { specId: string | null; title: string; domain: string | null; proposed: boolean; by: 'classifier' | 'domain' | 'existing'; p?: number } | null;
  /** How placement was decided; for `domain`, why the classifier did not run. */
  placement?: { by: 'classifier'; p: number; model: string | null; decisionRecordId: string | null } | { by: 'domain'; reason: string } | { by: 'existing' };
  /** A classifier answer below the bar (or new_area/unsure): left Unfiled, offered as this. */
  suggestion?: { specId: string | null; title: string; answer: 'area' | 'new_area' | 'unsure'; p: number };
  provenance: { path: string; commitSha: string; blobSha: string; prNumber: number | null };
  metadata: SpecMetadata;
  /** Mechanical fields that could not be read and are not imported. */
  unread: string[];
  duplicates: DuplicateCandidate[];
  /** Why the duplicate check did not run, when it did not. */
  duplicateCheck: string | null;
}

export interface ImportResult {
  dryRun: boolean;
  repo: string;
  commitSha: string;
  batchId: string | null;
  /** This page's files, in path order. */
  files: ImportFileRow[];
  counts: { create: number; reimport: number; exists: number; skip: number };
  /** Page size used. */
  limit: number;
  /** Files after this page; 0 on the last page. A page cut short by its time bound leaves more. */
  remaining: number;
  /** Pass as `cursor` for the next page (same commit); null on the last page. */
  nextCursor: string | null;
  /** Files to create or re-import, per area, for the summary. */
  byArea: Array<{ area: string; areaSpecId: string | null; proposed: boolean; count: number; by: 'classifier' | 'domain' | 'existing' | null }>;
}

export interface ImportInput { workspaceId: unknown; dryRun?: unknown; ref?: unknown; paths?: unknown; allowDuplicates?: unknown; limit?: unknown; cursor?: unknown; attachProvenance?: unknown; attachTo?: unknown }

type NativeSpec = { id: string; title: string; metadata: SpecRow['metadata']; repoRefs: Array<{ path: string; commitSha: string }> | null };

/**
 * The spec already in buildd a repo file is: one that recorded it as its
 * provenance, then the exact title (any case). Citing the path is not enough:
 * a spec cites contracts it builds on, which are other specs (see `relatedTo`).
 */
function nativeMatch(natives: readonly NativeSpec[], path: string, title: string): { spec: NativeSpec; matchedBy: 'provenance' | 'title' } | null {
  const prov = natives.find((n) => n.metadata?.repo_provenance?.path === path);
  if (prov) return { spec: prov, matchedBy: 'provenance' };
  const t = title.trim().toLowerCase();
  const byTitle = natives.find((n) => n.title.trim().toLowerCase() === t);
  return byTitle ? { spec: byTitle, matchedBy: 'title' } : null;
}

/** Native specs whose head revision cites the path: a hint for a person, never a match. */
const relatedTo = (natives: readonly NativeSpec[], path: string, except: string | null) =>
  natives.filter((n) => n.id !== except && (n.repoRefs ?? []).some((r) => r.path === path));

/**
 * Area by `domain:` value: each value an area declares (metadata `domains`)
 * first, then each area's title slug for a value no area declares.
 */
export function areasByDomain(areas: readonly Pick<AreaInfo, 'id' | 'title' | 'scope' | 'domains'>[]): Map<string, Pick<AreaInfo, 'id' | 'title'>> {
  const domainAreas = areas.filter((a) => a.scope === 'domain').sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const out = new Map<string, Pick<AreaInfo, 'id' | 'title'>>();
  for (const a of domainAreas) for (const d of a.domains ?? []) if (!out.has(d)) out.set(d, a);
  for (const a of domainAreas) { const slug = areaDomain(a.title); if (!out.has(slug)) out.set(slug, a); }
  return out;
}

const titleFromDomain = (d: string) => d.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : null);

const NOT_PLACED = 'no single area';

export async function importRepoSpecs(caller: SpecCaller, input: ImportInput, deps: ImportDeps = defaultImportDeps): Promise<{ ok: true; result: ImportResult } | SpecError> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const { workspaceId } = input;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) return fail(400, 'workspaceId must be a UUID');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') return fail(400, 'dryRun is true or false (default true)');
  const dryRun = input.dryRun !== false;
  if (input.ref !== undefined && (typeof input.ref !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(input.ref))) return fail(400, 'ref is a branch name or a commit SHA');
  const only = input.paths === undefined ? null : strList(input.paths);
  if (input.paths !== undefined && !only) return fail(400, 'paths is a list of docs/specs/<file>.md paths');
  const allow = new Set(input.allowDuplicates === undefined ? [] : strList(input.allowDuplicates) ?? []);
  if (input.allowDuplicates !== undefined && !strList(input.allowDuplicates)) return fail(400, 'allowDuplicates is a list of paths');
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_IMPORT_PAGE)) {
    return fail(400, `limit is a whole number of files per page, 1 to ${MAX_IMPORT_PAGE} (default ${DEFAULT_IMPORT_PAGE})`);
  }
  const limit = (input.limit as number | undefined) ?? DEFAULT_IMPORT_PAGE;
  const cursor = input.cursor === undefined || input.cursor === null ? null : decodeImportCursor(input.cursor);
  if (input.cursor !== undefined && input.cursor !== null && !cursor) return fail(400, 'cursor is the nextCursor a previous import page returned');
  if (input.attachProvenance !== undefined && typeof input.attachProvenance !== 'boolean') return fail(400, 'attachProvenance is true or false');
  const attachProvenance = input.attachProvenance === true;
  // A person names the native spec a file should be recorded on: the only way a related spec becomes the match.
  const ATTACH_TO = 'attachTo maps a docs/specs/<file>.md path to the id of the native spec in this workspace to record it on';
  let attachTo = new Map<string, string>();
  if (input.attachTo !== undefined && input.attachTo !== null) {
    const v = input.attachTo;
    if (typeof v !== 'object' || Array.isArray(v)) return fail(400, ATTACH_TO);
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > MAX_IMPORT_FILES || !entries.every(([k, id]) => k.startsWith(`${SPECS_DIR}/`) && typeof id === 'string' && isUuid(id))) return fail(400, ATTACH_TO);
    attachTo = new Map(entries as Array<[string, string]>);
  }
  if (!(await reach(caller, workspaceId, true))) return fail(404, 'Workspace not found');

  const repo = await deps.repo(workspaceId);
  if (!repo) return fail(400, 'this workspace has no GitHub repo linked through the GitHub App, so there is nothing to import');
  let commitSha: string;
  let files: RepoSpecFile[];
  try {
    // A cursor pins the commit its first page read, so every page comes from one commit.
    commitSha = cursor ? cursor.c : await resolveCommit(workspaceId, repo, input.ref as string | undefined, deps);
    files = await readSpecDir(repo, commitSha, deps);
  } catch (err) {
    return fail(502, `GitHub could not be read: ${errMsg(err)}; nothing was imported`);
  }
  if (only) files = files.filter((f) => only.includes(f.path));
  if (cursor) files = files.filter((f) => f.path.localeCompare(cursor.a) > 0);
  const after = files.length;
  files = files.slice(0, limit);

  const [areas, existing, natives] = await Promise.all([
    listAreas(workspaceId),
    db.select().from(specs).where(and(eq(specs.workspaceId, workspaceId), isNotNull(specs.repoSource))),
    db.select({ id: specs.id, title: specs.title, metadata: specs.metadata, repoRefs: specRevisions.repoRefs }).from(specs)
      .leftJoin(specRevisions, and(eq(specRevisions.specId, specs.id), eq(specRevisions.revision, specs.headRevision)))
      .where(and(eq(specs.workspaceId, workspaceId), isNull(specs.repoSource), notInArray(specs.scope, [...AREA_SCOPES]), notInArray(specs.status, [...AREA_GONE_STATUSES])))
      .orderBy(specs.createdAt),
  ]);
  const nativeById = new Map(natives.map((n) => [n.id, n]));
  for (const id of attachTo.values()) if (!nativeById.has(id)) return fail(400, `attachTo names ${id}, which is not a native spec in this workspace`);
  const areaByDomain = areasByDomain(areas);
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const byPath = new Map(existing.map((s) => [s.repoSource!.path, s]));
  const parsed = files.map((f) => ({ f, p: repoSpecForImport(f.path, f.text) }));
  const wanted = parsed.filter((x) => x.p.ok).map((x) => x.f.path);
  const prs = wanted.length ? await lastPrs(repo, commitSha, wanted, deps) : new Map<string, number | null>();
  const who = author(caller);
  const ids = caller.kind === 'user' ? { userId: caller.userId } : { accountId: caller.account.id };
  const { SPEC_DUPLICATE_CHECK } = await import('@/modules');
  const classify = deps.classify ?? (await (await import('./organize')).areaClassifier());
  const batchId = dryRun ? null : randomUUID();
  const importedAt = deps.now().toISOString();
  const specUrl = (id: string) => `${appBaseUrl()}/app/specs/${id}`;

  /** The declared-domain mapping (R-18): the fallback when the classifier does not run. */
  const byDomain = (domain: string | null): ImportFileRow['area'] => {
    const match = domain ? areaByDomain.get(domain) : undefined;
    // A cross-cutting value (`surfaces`, `api`) names a kind of code, not a part of the product: never an area of its own (§17 R-4).
    return match
      ? { specId: match.id, title: match.title, domain, proposed: false, by: 'domain' }
      : domain && !CROSS_CUTTING_DOMAINS.has(domain) ? { specId: null, title: titleFromDomain(domain), domain, proposed: true, by: 'domain' } : null;
  };

  /** Place one new spec through the classifier (§17), else by domain. Sets area, placement and suggestion on the row. Never throws. */
  const placeRow = async (row: ImportFileRow, p: { title: string; body: string; domain: string | null }, subjectId: string): Promise<void> => {
    let c: AreaClassification = { ran: false, reason: 'the workspace has no areas' };
    if (areas.length) {
      try {
        c = await classify({ workspaceId, specId: subjectId, card: specCard(p.title, p.body), areas, ...('userId' in ids ? { userId: ids.userId } : { accountId: ids.accountId }), hint: { domain: p.domain } });
      } catch (err) {
        c = { ran: false, reason: `the area check failed (${errMsg(err)})` };
      }
    }
    if (c.ran) {
      // The classifier may only name an area it was shown, in this workspace (R-6, R-8).
      const named = c.answer === 'area' && c.areaId ? areaById.get(c.areaId) : undefined;
      row.placement = { by: 'classifier', p: c.p, model: c.model, decisionRecordId: c.decisionRecordId };
      if (named && c.confident) {
        row.area = { specId: named.id, title: named.title, domain: p.domain, proposed: false, by: 'classifier', p: c.p };
        return;
      }
      row.area = null;
      const answer = named ? 'area' : c.answer === 'new_area' ? 'new_area' : 'unsure';
      const title = named ? named.title
        : answer === 'new_area' ? `a new area${p.domain && !CROSS_CUTTING_DOMAINS.has(p.domain) ? ` (${titleFromDomain(p.domain)})` : ''}` : NOT_PLACED;
      row.suggestion = { specId: named?.id ?? null, title, answer, p: c.p };
      return;
    }
    row.area = byDomain(p.domain);
    row.placement = { by: 'domain', reason: c.reason };
  };

  const one = async ({ f, p }: (typeof parsed)[number]): Promise<ImportFileRow> => {
    const provenance = { path: f.path, commitSha, blobSha: f.blobSha, prNumber: prs.get(f.path) ?? null };
    const base = { path: f.path, provenance, metadata: {}, unread: [], duplicates: [], duplicateCheck: null, area: null } satisfies Omit<ImportFileRow, 'action'>;
    if (!p.ok) return { ...base, action: 'skip', reason: p.reason, message: p.message };
    const row: ImportFileRow = { ...base, metadata: p.metadata, unread: p.unread, action: 'create', spec: { title: p.title, scope: 'feature', body: p.body } };
    const prior = byPath.get(f.path);
    if (prior?.repoSource?.state === 'confirmed') return { ...row, action: 'skip', reason: 'confirmed', message: `${f.path} was imported and confirmed; buildd is its source now`, specId: prior.id };
    if (prior && prior.repoSource!.blobSha === f.blobSha) return { ...row, action: 'skip', reason: 'already_imported', message: `${f.path} is imported at this blob already`, specId: prior.id };
    if (!prior) {
      // Already in buildd as the same spec: never a second one, at most its provenance.
      const namedId = attachTo.get(f.path);
      const m = namedId ? { spec: nativeById.get(namedId)!, matchedBy: 'named' as const } : nativeMatch(natives, f.path, p.title);
      if (m) {
        const how = m.matchedBy === 'named' ? 'named in attachTo' : m.matchedBy === 'provenance' ? 'matched by its recorded provenance' : 'matched by title';
        const existingRow: ImportFileRow = {
          ...row, action: 'exists', specId: m.spec.id,
          existing: { specId: m.spec.id, title: m.spec.title, url: specUrl(m.spec.id), matchedBy: m.matchedBy },
          message: `already in buildd as "${m.spec.title}" (${m.spec.id}, ${how}); not created`,
        };
        // Naming the spec is the person's explicit ask to record the file on it.
        if (!dryRun && (attachProvenance || m.matchedBy === 'named')) {
          const r = await updateSpecMetadata(caller, m.spec.id, { changes: { repo_provenance: provenance }, reason: `Matched to ${f.path}@${commitSha.slice(0, 7)} on import` });
          if (r.ok) existingRow.provenanceAttached = true;
          else existingRow.message = `${existingRow.message}; provenance not recorded: ${r.error}`;
        }
        return existingRow;
      }
      const related = relatedTo(natives, f.path, null);
      if (related.length) row.related = related.map((n) => ({ specId: n.id, title: n.title, url: specUrl(n.id) }));
    }
    if (p.body.length > 400_000) return { ...row, action: 'skip', reason: 'too_large', message: `${f.path} is longer than a spec body may be` };
    if (prior) {
      // Filed (or not) by its first import: a re-import moves nothing.
      row.action = 'reimport';
      row.specId = prior.id;
      const parent = prior.parentSpecId ? areaById.get(prior.parentSpecId) : undefined;
      row.area = parent ? { specId: parent.id, title: parent.title, domain: p.domain, proposed: false, by: 'existing' } : null;
      row.placement = { by: 'existing' };
    } else {
      // §13: an imported spec is checked like a new draft, against the approved ones.
      const d = deps.duplicates === false ? null : await SPEC_DUPLICATE_CHECK({ workspaceId, title: p.title, body: p.body, ...('userId' in ids ? { userId: ids.userId } : { accountId: ids.accountId }) }, deps.duplicates ?? {});
      if (d && d.ran) row.duplicates = [...d.blocking, ...d.warnings];
      else if (d) row.duplicateCheck = d.reason;
      if (d?.ran && d.blocking.length && !allow.has(f.path)) {
        row.message = `looks like a duplicate of ${d.blocking.map((x) => `"${x.title}" (${x.specId})`).join(', ')}`;
        if (!dryRun) return { ...row, action: 'skip', reason: 'duplicate', message: `${row.message}; not imported. Pass allowDuplicates: ["${f.path}"] to import it anyway` };
      }
    }
    if (dryRun) {
      if (!prior) await placeRow(row, p, `import:${f.path}`);
      return row;
    }
    return writeImport(caller, workspaceId, row, prior ?? null, { importedAt, batchId: batchId!, by: who.label, ids, place: (specId) => placeRow(row, p, specId) });
  };

  // IMPORT_CONCURRENCY files at a time, in path order; once the page has run its budget no new file starts.
  // Started files are always a prefix of the page, so the cursor is the last of them.
  const budget = deps.pageBudgetMs ?? IMPORT_PAGE_BUDGET_MS;
  const rows: ImportFileRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < parsed.length) {
      if (next > 0 && clock() - started >= budget) return;
      const i = next++;
      rows[i] = await one(parsed[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, parsed.length) }, worker));
  const covered = next;
  const remaining = Math.max(0, after - covered);
  const nextCursor = remaining > 0 ? encodeImportCursor({ c: commitSha, a: parsed[covered - 1]!.f.path }) : null;

  const counts = { create: 0, reimport: 0, exists: 0, skip: 0 };
  const areaCount = new Map<string, ImportResult['byArea'][number]>();
  for (const r of rows) {
    counts[r.action]++;
    if (r.action === 'skip' || r.action === 'exists') continue;
    const key = r.area ? `${r.area.specId ?? 'new'}:${r.area.title}:${r.area.by}` : 'unfiled';
    const cur = areaCount.get(key) ?? { area: r.area?.title ?? 'Unfiled', areaSpecId: r.area?.specId ?? null, proposed: !!r.area?.proposed, count: 0, by: r.area?.by ?? null };
    cur.count++;
    areaCount.set(key, cur);
  }
  return {
    ok: true,
    result: {
      dryRun, repo: repo.fullName, commitSha, batchId, files: rows, counts, limit, remaining, nextCursor,
      byArea: [...areaCount.values()].sort((a, b) => b.count - a.count || a.area.localeCompare(b.area)),
    },
  };
}

/** Write one file's import: a new spec, or a new imported revision of the one it was. Never throws. */
async function writeImport(caller: SpecCaller, workspaceId: string, row: ImportFileRow, prior: SpecRow | null, ctx: { importedAt: string; batchId: string; by: string; ids: { userId: string } | { accountId: string }; place: (specId: string) => Promise<void> }): Promise<ImportFileRow> {
  const imported = { ...row.provenance, importedAt: ctx.importedAt };
  const summary = `Imported from ${row.path}@${row.provenance.commitSha.slice(0, 7)}${row.provenance.prNumber ? ` (last changed in #${row.provenance.prNumber})` : ''}`;
  try {
    let specId: string;
    let revision: number;
    if (prior) {
      const r = await reviseSpecDraft(caller, prior.id, { expectedVersion: prior.version, body: row.spec!.body, changeSummary: summary }, { imported });
      if (!r.ok) return { ...row, action: 'skip', reason: 'failed', message: r.error };
      specId = prior.id;
      revision = r.revision.revision;
      if (r.unchanged) {
        // Only mechanical fields moved: no new revision, the provenance follows the file.
        await db.update(specs).set({ repoSource: { ...prior.repoSource!, ...row.provenance, importedAt: ctx.importedAt } }).where(eq(specs.id, prior.id));
      }
    } else {
      const r = await createSpecDraft(caller, { workspaceId, title: row.spec!.title, scope: 'feature', body: row.spec!.body, changeSummary: summary }, { duplicates: false, imported });
      if (!r.ok) return { ...row, action: 'skip', reason: 'failed', message: r.error };
      specId = r.spec.id;
      revision = 1;
      // Asked about the spec just created, so the decision's subject is that spec.
      await ctx.place(specId);
      await fileImported(workspaceId, specId, row, ctx);
    }
    // A re-import also clears a mechanical field the file no longer states.
    const cleared = prior ? Object.fromEntries(Object.keys(prior.metadata ?? {}).filter((k) => (FILE_METADATA_KEYS as readonly string[]).includes(k) && !(k in row.metadata)).map((k) => [k, null])) : {};
    const unread = [...row.unread, ...(await importMetadata(caller, specId, { ...cleared, ...row.metadata }, summary))];
    return { ...row, specId, revision, unread };
  } catch (err) {
    console.error(`[spec-import] ${row.path} failed:`, err);
    return { ...row, action: 'skip', reason: 'failed', message: errMsg(err) };
  }
}

/**
 * File a new import where placement put it: a confident classifier answer or
 * the domain fallback's existing area is applied (with undo); a classifier
 * suggestion is recorded open for a person; with neither, the organize path
 * places it after the response (§17).
 */
async function fileImported(workspaceId: string, specId: string, row: ImportFileRow, ctx: { batchId: string; by: string; ids: { userId: string } | { accountId: string } }): Promise<void> {
  const pl = row.placement;
  const model = pl?.by === 'classifier' ? pl : null;
  if (row.area?.specId) {
    if (await setParentIfUnfiled(workspaceId, specId, row.area.specId)) {
      await insertFiling({
        workspaceId, specId, kind: 'filed', status: 'applied', source: model ? 'model' : 'domain', previousParentId: null, parentSpecId: row.area.specId,
        proposal: model ? { answer: 'area', p: model.p, model: model.model, domain: row.area.domain, path: row.path } : { answer: 'domain', domain: row.area.domain, path: row.path },
        decisionRecordId: model?.decisionRecordId ?? null, batchId: ctx.batchId, createdBy: 'buildd',
      });
    }
    return;
  }
  if (model && row.suggestion) {
    await insertFiling({
      workspaceId, specId, kind: 'suggested', status: 'open', source: 'model', parentSpecId: row.suggestion.specId,
      proposal: { answer: row.suggestion.answer, p: row.suggestion.p, model: model.model, path: row.path }, decisionRecordId: model.decisionRecordId, batchId: ctx.batchId, createdBy: 'buildd',
    });
    return;
  }
  specApprovalDeps.afterResponse(async () => {
    const { organizeNewSpec } = await import('./organize');
    await organizeNewSpec(specId, { by: ctx.by, ...ctx.ids, body: row.spec!.body });
  });
}

/** The mechanical fields into the metadata block (R-14), with a change row each. Returns fields that did not validate. */
async function importMetadata(caller: SpecCaller, specId: string, metadata: Record<string, unknown>, reason: string): Promise<string[]> {
  const fields = Object.entries(metadata).filter(([, v]) => v !== undefined);
  if (!fields.length) return [];
  const all = await updateSpecMetadata(caller, specId, { changes: Object.fromEntries(fields), reason });
  if (all.ok) return [];
  const bad: string[] = [];
  for (const [k, v] of fields) {
    const one = await updateSpecMetadata(caller, specId, { changes: { [k]: v }, reason });
    if (!one.ok) bad.push(k);
  }
  return bad;
}

// ── Confirmation ────────────────────────────────────────────────────────────

export interface ConfirmResult {
  confirmed: Array<{ specId: string; title: string; path: string; commitSha: string; revision: number; area: string | null }>;
  skipped: Array<{ specId: string; title?: string; path?: string; reason: 'stale' | 'not_imported' | 'not_found' | 'conflict' | 'unavailable'; message: string }>;
  /** From an OAuth session: where the person confirms. Nothing is approved. */
  pending?: { confirmUrl: string; specIds: string[] };
}

const NOT_A_PERSON = 'Confirming an import approves each spec, which is a person\'s decision: an owner or admin of this team, or a delegated approver, from their own session. An agent run or API key cannot confirm.';
export const MAX_CONFIRM_BATCH = 200;

/** The index page an OAuth session's confirmation link opens. */
export const importConfirmPath = (workspaceId: string) => `/app/workspaces/${workspaceId}/specs#imported`;

export async function confirmImportedSpecs(caller: SpecCaller, input: { workspaceId?: unknown; specIds: unknown }, deps: ImportDeps = defaultImportDeps): Promise<{ ok: true; result: ConfirmResult } | SpecError> {
  const specIds = strList(input.specIds);
  if (!specIds || !specIds.length || specIds.length > MAX_CONFIRM_BATCH || !specIds.every(isUuid)) return fail(400, `specIds is a list of 1 to ${MAX_CONFIRM_BATCH} spec ids`);
  let workspaceId = input.workspaceId;
  if (workspaceId === undefined || workspaceId === null) {
    // Without one, the batch names it: every spec must be in the same workspace.
    const found = await db.selectDistinct({ workspaceId: specs.workspaceId }).from(specs).where(inArray(specs.id, specIds));
    if (found.length !== 1) return fail(400, found.length ? 'specIds span more than one workspace: confirm one workspace at a time' : 'Spec not found');
    workspaceId = found[0]!.workspaceId;
  }
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) return fail(400, 'workspaceId must be a UUID');
  if (!(await reach(caller, workspaceId, false))) return fail(404, 'Workspace not found');
  // An agent run or API key never confirms; a person's OAuth session (maybe driven by an agent) gets a link.
  if (caller.kind === 'account') {
    const personId = requestingPerson(null, caller.account);
    if (!personId || !(await specApprover(caller, workspaceId))) return fail(403, NOT_A_PERSON);
    return { ok: true, result: { confirmed: [], skipped: [], pending: { confirmUrl: `${appBaseUrl()}${importConfirmPath(workspaceId)}`, specIds } } };
  }
  if (!(await specApprover(caller, workspaceId))) return fail(403, NOT_A_PERSON);

  const rows = await db.select().from(specs).where(eq(specs.workspaceId, workspaceId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result: ConfirmResult = { confirmed: [], skipped: [] };
  const todo: SpecRow[] = [];
  for (const id of [...new Set(specIds)]) {
    const s = byId.get(id);
    if (!s) { result.skipped.push({ specId: id, reason: 'not_found', message: 'no spec with this id in this workspace' }); continue; }
    if (s.repoSource?.state !== 'imported' || s.repoSource.revision !== s.headRevision) {
      result.skipped.push({ specId: id, title: s.title, path: s.repoSource?.path, reason: 'not_imported', message: s.repoSource?.state === 'confirmed' ? 'already confirmed' : 'no imported revision is waiting for confirmation' });
      continue;
    }
    todo.push(s);
  }
  if (!todo.length) return { ok: true, result };

  // R-19: each approval only while its file is unchanged since the imported commit, read once at the default branch head.
  const repo = await deps.repo(workspaceId);
  let current: Map<string, string> | null = null;
  let unavailable = 'this workspace has no GitHub repo linked through the GitHub App';
  if (repo) {
    try {
      const head = await resolveCommit(workspaceId, repo, undefined, deps);
      current = new Map((await readSpecDir(repo, head, deps)).map((f) => [f.path, f.blobSha]));
    } catch (err) {
      unavailable = `GitHub could not be read: ${errMsg(err)}`;
    }
  }
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  for (const s of todo) {
    const src = s.repoSource!;
    const short = src.commitSha.slice(0, 7);
    if (!current) { result.skipped.push({ specId: s.id, title: s.title, path: src.path, reason: 'unavailable', message: `${unavailable}; nothing was confirmed, try again` }); continue; }
    const now = current.get(src.path);
    if (now !== src.blobSha) {
      result.skipped.push({ specId: s.id, title: s.title, path: src.path, reason: 'stale', message: now ? `${src.path} changed since ${short}: run import again, then confirm the new revision` : `${src.path} is no longer in the repo at the default branch` });
      continue;
    }
    const r = await approveSpecRevision(caller, s.id, { revision: s.headRevision, expectedVersion: s.version }, { importConfirmation: { note: `confirmed import of ${src.path}@${short}` } });
    if (!r.ok || 'pending' in r) {
      result.skipped.push({ specId: s.id, title: s.title, path: src.path, reason: 'conflict', message: r.ok ? 'not approved' : r.error });
      continue;
    }
    result.confirmed.push({ specId: s.id, title: s.title, path: src.path, commitSha: src.commitSha, revision: s.headRevision, area: s.parentSpecId ? titles.get(s.parentSpecId) ?? null : null });
  }
  return { ok: true, result };
}
