import { db } from '@buildd/core/db';
import { specRevisions, specs, workspaces, type SpecMetadataBlock, type SpecPublicationDecision, type SpecRepoCopyState, type SpecRepoSource } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { githubApi, checkSuitesAllPassed, type CheckSuiteSummary } from '@/lib/github';
import { appBaseUrl } from '@/lib/app-url';
import { renderRepoCopy, specShortId, verifyRepoCopy, type RepoCopy } from '@buildd/spec-contract/repo-copy';
import {
  buildSpecIndex, crossCheckSpecs, lintSpecFile, parseSpecFrontmatter, readDomainList, SPEC_META_FILES, withDomain, type IndexedSpec,
} from '@buildd/spec-contract/repo-spec';
import { linkedRepo } from './repo-source';
import { scanForProdData } from './no-prod-data-scan';
import { publicationMark, readPublicationPolicy } from './publication';
import { fail, type SpecCaller, type SpecError, type SpecRow } from './store';
import type { PublicationDecideInput, PublicationOutcome } from '@/lib/spec-publication-decision';

/**
 * Native spec homes with a generated repo copy (docs/specs/living-specs.md
 * §18, D-13). In a workspace that opts in (`gitConfig.livingSpecs.nativeSource`,
 * R-12), the native spec is the source and each approved revision, and each
 * metadata change (R-31), is written to `docs/specs/<slug>.md` by one PR per
 * spec (R-15), opened through the workspace's GitHub App installation.
 *
 * That PR is a named exception to the merge policy (R-35,
 * GENERATED_SPEC_COPY_EXCEPTION): it lands on green CI with no review, because
 * the approval was the review. Only a head commit the generator wrote lands
 * under it; any other head is refused (AC-97). A red check leaves it open and
 * the spec page says the repo copy is behind, naming the check (AC-79).
 *
 * The copy also brings `docs/specs/INDEX.md` up to date, and adds the spec's
 * domain to `DOMAINS` in `scripts/check-specs.ts` when it is new (R-32), so
 * `specs:lint` passes on the generated PR.
 *
 * An imported spec (R-18, ./import.ts) gets nothing here until a person
 * confirms it: its repo file is still the source. Once confirmed, its copy is
 * written over the file it was imported from.
 *
 * Before anything is written to GitHub (Slice 14, AC-52), the publication
 * decision (`buildd.spec_publication`, ./publication.ts) reads the copy's
 * exact text: the production-data scan, the workspace's publication policy
 * and the spec's mark. A revision it keeps private gets no copy and makes no
 * GitHub write; a copy already in the repo is listed with a PR that removes
 * it, which only a person merges (R-70).
 */

/** The merge-policy exception the generated PR lands under (R-35). */
export const GENERATED_SPEC_COPY_EXCEPTION = 'generated-spec-copy';

export type Api = (installationId: number, path: string, init?: RequestInit) => Promise<any>;
export type PublicationDecide = (input: PublicationDecideInput) => Promise<PublicationOutcome>;
export interface RepoCopyDeps {
  api: Api;
  repo: (workspaceId: string) => Promise<{ fullName: string; installationId: number } | null>;
  now: () => Date;
  /** The publication decision; the decisions module's slot when absent. */
  decide?: PublicationDecide;
}
export const defaultRepoCopyDeps: RepoCopyDeps = { api: githubApi, repo: linkedRepo, now: () => new Date() };

/** R-12: off unless the workspace says so. */
export function nativeSourceOn(gitConfig: unknown): boolean {
  const ls = (gitConfig as { livingSpecs?: unknown } | null)?.livingSpecs;
  return !!ls && typeof ls === 'object' && (ls as { nativeSource?: unknown }).nativeSource === true;
}

/** A domain value from an area title: lowercase words joined by hyphens. Each area maps to exactly one. */
export function areaDomain(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'area';
}

/** A file slug from a spec title. */
export const specSlug = (title: string): string => areaDomain(title).slice(0, 60) || 'spec';

/** The file a confirmed import came from: its copy is written there (R-18). Null before confirmation or for a spec never imported. */
export const confirmedImportPath = (spec: Pick<SpecRow, 'repoSource'>): string | undefined =>
  (spec.repoSource?.state === 'confirmed' ? spec.repoSource.path : undefined);

/**
 * An area's `domain:` value: the first one it declares (its metadata block's
 * `domains`), else its title's slug. A declared value is one the repo's
 * DOMAINS list already uses, where a slug like `tasks-and-missions` is not.
 */
export function domainOfArea(area: { title: string; metadata?: SpecMetadataBlock | null }): string {
  return area.metadata?.domains?.[0] ?? areaDomain(area.title);
}

/** The spec's filed area (R-32): itself if it is one, else its nearest ancestor with scope `domain`. */
export async function specArea(specId: string): Promise<{ id: string; title: string; domain: string } | null> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE up(id, parent_spec_id, scope, title, metadata, depth) AS (
      SELECT s.id, s.parent_spec_id, s.scope, s.title, s.metadata, 0 FROM specs s WHERE s.id = ${specId}::uuid
      UNION ALL
      SELECT p.id, p.parent_spec_id, p.scope, p.title, p.metadata, up.depth + 1
      FROM specs p JOIN up ON p.id = up.parent_spec_id
      WHERE up.depth < 50 AND up.scope <> 'domain'
    )
    SELECT id, title, metadata FROM up WHERE scope = 'domain' ORDER BY depth LIMIT 1`)) as unknown as { rows: Array<{ id: string; title: string; metadata: SpecMetadataBlock | string | null }> };
  const a = rows.rows[0];
  if (!a) return null;
  const metadata = typeof a.metadata === 'string' ? (JSON.parse(a.metadata) as SpecMetadataBlock) : a.metadata;
  return { id: a.id, title: a.title, domain: domainOfArea({ title: a.title, metadata }) };
}

export type BuiltCopy =
  | { ok: true; copy: RepoCopy; path: string; domain: string; revision: number; shortId: string; title: string }
  | { ok: false; reason: 'not_opted_in' | 'not_found' | 'not_approved' | 'unfiled' | 'unrenderable'; message: string };

/** The copy of one revision (the approved one by default), rendered but not written. */
export async function buildSpecRepoCopy(spec: SpecRow, opts: { revision?: number; now?: Date } = {}): Promise<BuiltCopy> {
  const n = opts.revision ?? spec.approvedRevision;
  if (n == null) return { ok: false, reason: 'not_approved', message: 'nothing is approved yet' };
  const [rev] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, spec.id), eq(specRevisions.revision, n))).limit(1);
  if (!rev) return { ok: false, reason: 'not_found', message: `revision ${n} not found` };
  const area = await specArea(spec.id);
  if (!area) return { ok: false, reason: 'unfiled', message: 'this spec is not filed under an area, so it has no domain and no repo copy is generated until it is filed' };
  const body = (await getArtifactRevision(spec.bodyArtifactId, rev.artifactRevision))?.content ?? '';
  const metadata: SpecMetadataBlock = spec.metadata ?? {};
  const shortId = specShortId(spec.id);
  const approvedOn = (rev.approvedAt ?? opts.now ?? new Date()).toISOString().slice(0, 10);
  const copy = await renderRepoCopy({
    shortId, revision: n, title: spec.title, body, metadata, domain: area.domain,
    status: (metadata.verified_by ?? []).length ? 'active' : 'draft',
    defaultOwner: 'buildd', defaultLastVerified: approvedOn,
  });
  if (!copy.ok) return { ok: false, reason: 'unrenderable', message: copy.message };
  const path = spec.repoCopy?.path ?? confirmedImportPath(spec) ?? `docs/specs/${specSlug(spec.title)}.md`;
  return { ok: true, copy, path, domain: area.domain, revision: n, shortId, title: spec.title };
}

// ── The repo as it stands on the base branch ────────────────────────────────

interface RepoState {
  fullName: string;
  installationId: number;
  base: string;
  baseSha: string;
  baseTreeSha: string;
  /** docs/specs/*.md by file name. */
  specFiles: Map<string, string>;
  checkSpecsSource: string | null;
  /** Every path in the tree, when GitHub returned it whole. */
  paths: Set<string> | null;
}

async function readRepoState(workspaceId: string, deps: RepoCopyDeps, withPaths: boolean): Promise<RepoState | { error: string }> {
  const repo = await deps.repo(workspaceId);
  if (!repo) return { error: 'this workspace has no GitHub repo linked through the GitHub App' };
  const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const meta = await deps.api(repo.installationId, `/repos/${repo.fullName}`);
  const configured = (ws?.gitConfig as { defaultBranch?: unknown } | null)?.defaultBranch;
  const base: string = (typeof configured === 'string' && configured) || meta?.default_branch || 'main';
  const ref = await deps.api(repo.installationId, `/repos/${repo.fullName}/git/ref/heads/${base.split('/').map(encodeURIComponent).join('/')}`);
  const baseSha: string = ref?.object?.sha;
  const commit = await deps.api(repo.installationId, `/repos/${repo.fullName}/git/commits/${baseSha}`);
  const [owner, name] = repo.fullName.split('/');
  const gql = await deps.api(repo.installationId, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!, $specs: String!, $script: String!) {
        repository(owner: $owner, name: $name) {
          specs: object(expression: $specs) { ... on Tree { entries { name type object { ... on Blob { text } } } } }
          script: object(expression: $script) { ... on Blob { text } }
        }
      }`,
      variables: { owner, name, specs: `${baseSha}:docs/specs`, script: `${baseSha}:scripts/check-specs.ts` },
    }),
  });
  const specFiles = new Map<string, string>();
  for (const e of gql?.data?.repository?.specs?.entries ?? []) {
    if (e?.type === 'blob' && typeof e.name === 'string' && e.name.endsWith('.md') && typeof e.object?.text === 'string') specFiles.set(e.name, e.object.text);
  }
  let paths: Set<string> | null = null;
  if (withPaths) {
    const tree = await deps.api(repo.installationId, `/repos/${repo.fullName}/git/trees/${baseSha}?recursive=1`).catch(() => null);
    if (tree && !tree.truncated && Array.isArray(tree.tree)) paths = new Set(tree.tree.map((t: { path: string }) => t.path));
  }
  return {
    fullName: repo.fullName, installationId: repo.installationId, base, baseSha, baseTreeSha: commit?.tree?.sha,
    specFiles, checkSpecsSource: gql?.data?.repository?.script?.text ?? null, paths,
  };
}

/** Pick the file for a spec: its recorded path, else its title's slug, else the slug with its short id when that file is someone else's. */
async function choosePath(built: Extract<BuiltCopy, { ok: true }>, recorded: string | undefined, files: Map<string, string>): Promise<string> {
  if (recorded) return recorded;
  const name = built.path.slice('docs/specs/'.length);
  const there = files.get(name);
  if (there === undefined || SPEC_META_FILES.has(name)) return SPEC_META_FILES.has(name) ? `docs/specs/${name.replace(/\.md$/, '')}-${built.shortId}.md` : built.path;
  const v = await verifyRepoCopy(there);
  return v.generated && v.shortId === built.shortId ? built.path : `docs/specs/${name.replace(/\.md$/, '')}-${built.shortId}.md`;
}

/** The files the generated PR writes: the copy, the index, and DOMAINS when the domain is new. */
export function generatedFiles(built: Extract<BuiltCopy, { ok: true }>, path: string, state: Pick<RepoState, 'specFiles' | 'checkSpecsSource'>): { files: Array<{ path: string; content: string }>; domains: Set<string>; indexed: IndexedSpec[] } {
  const name = path.slice('docs/specs/'.length);
  const merged = new Map(state.specFiles);
  merged.set(name, built.copy.text);
  const indexed: IndexedSpec[] = [...merged.keys()].filter((f) => !SPEC_META_FILES.has(f)).sort().map((file) => ({
    file, slug: file.replace(/\.md$/, ''), fm: parseSpecFrontmatter(merged.get(file)!).fm ?? {},
  }));
  const files = [{ path, content: built.copy.text }, { path: 'docs/specs/INDEX.md', content: buildSpecIndex(indexed) }];
  const domains = new Set(state.checkSpecsSource ? readDomainList(state.checkSpecsSource) ?? [] : []);
  if (state.checkSpecsSource && !domains.has(built.domain)) {
    const next = withDomain(state.checkSpecsSource, built.domain);
    if (next) files.push({ path: 'scripts/check-specs.ts', content: next });
  }
  domains.add(built.domain);
  return { files: files.filter((f) => f.path !== 'docs/specs/INDEX.md' || state.specFiles.get('INDEX.md')?.trim() !== f.content.trim()), domains, indexed };
}

async function saveState(specId: string, state: SpecRepoCopyState): Promise<SpecRepoCopyState> {
  await db.update(specs).set({ repoCopy: state }).where(eq(specs.id, specId));
  return state;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * File or update the one generated PR for a spec (R-15): after an approval or
 * a metadata change. A workspace that has not opted in gets nothing (AC-78); a
 * spec with no area gets no copy (R-32). Never throws: the outcome is recorded
 * on the spec and returned.
 */
export async function fileSpecRepoCopy(specId: string, deps: RepoCopyDeps = defaultRepoCopyDeps): Promise<SpecRepoCopyState | null> {
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || spec.approvedRevision == null) return null;
  // AC-76: an unconfirmed import's repo file is its source; nothing is generated over it.
  if (spec.repoSource?.state === 'imported') return null;
  const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, spec.workspaceId)).limit(1);
  if (!nativeSourceOn(ws?.gitConfig)) return null;
  const at = () => deps.now().toISOString();
  const built = await buildSpecRepoCopy(spec, { now: deps.now() });
  if (!built.ok) {
    return saveState(specId, { ...(spec.repoCopy ?? {}), state: built.reason === 'unfiled' ? 'unfiled' : 'failed', error: built.message, updatedAt: at() });
  }
  // Slice 14: the scan and the decision clear the exact text before any GitHub write.
  const publication = await decideSpecPublication(spec, built, deps);
  if (!publication.publish) return keepPrivate(spec, publication, deps);
  try {
    const repo = await readRepoState(spec.workspaceId, deps, false);
    if ('error' in repo) return saveState(specId, { ...(spec.repoCopy ?? {}), state: 'failed', error: repo.error, updatedAt: at() });
    const path = await choosePath(built, spec.repoCopy?.path ?? confirmedImportPath(spec), repo.specFiles);
    const { files } = generatedFiles(built, path, repo);
    const branch = spec.repoCopy?.branch ?? `buildd/spec-copy-${built.shortId}`;
    const { api } = deps;
    const tree = await api(repo.installationId, `/repos/${repo.fullName}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: repo.baseTreeSha, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }),
    });
    const commit = await api(repo.installationId, `/repos/${repo.fullName}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message: `docs(specs): generate ${path.slice('docs/specs/'.length)} from spec ${built.shortId} revision ${built.revision}`, tree: tree?.sha, parents: [repo.baseSha] }),
    });
    const headSha: string | undefined = commit?.sha;
    if (!headSha) throw new Error('the generated commit was not created');
    const refPath = `/repos/${repo.fullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
    // The branch is the generator's: a force update replaces anything pushed to it by hand.
    try {
      await api(repo.installationId, refPath, { method: 'PATCH', body: JSON.stringify({ sha: headSha, force: true }) });
    } catch (err) {
      if (!/\b(404|422)\b/.test(errMsg(err))) throw err;
      await api(repo.installationId, `/repos/${repo.fullName}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }) });
    }
    const link = `${appBaseUrl()}/app/specs/${built.shortId}`;
    const title = `docs(specs): generated copy of ${built.title.replace(/\s+/g, ' ').slice(0, 120)} (revision ${built.revision})`;
    const body = [
      `The approved text of spec ${built.shortId}, revision ${built.revision}, written to the repo. Edit it in buildd, not here: ${link}`,
      '',
      `Generated by buildd. This PR lands on green CI with no review, because the approval was the review (merge-policy exception \`${GENERATED_SPEC_COPY_EXCEPTION}\`). A commit not written by the generator voids that.`,
      '',
      `Files: ${files.map((f) => `\`${f.path}\``).join(', ')}`,
    ].join('\n');
    let prNumber = spec.repoCopy?.prNumber;
    let open = false;
    if (prNumber) {
      const pr = await api(repo.installationId, `/repos/${repo.fullName}/pulls/${prNumber}`).catch(() => null);
      open = pr?.state === 'open';
    }
    if (!open) {
      const [owner] = repo.fullName.split('/');
      const existing = await api(repo.installationId, `/repos/${repo.fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`).catch(() => []);
      prNumber = Array.isArray(existing) && existing[0]?.number ? existing[0].number : undefined;
      open = !!prNumber;
    }
    if (open && prNumber) {
      await api(repo.installationId, `/repos/${repo.fullName}/pulls/${prNumber}`, { method: 'PATCH', body: JSON.stringify({ title, body }) });
    } else {
      const pr = await api(repo.installationId, `/repos/${repo.fullName}/pulls`, { method: 'POST', body: JSON.stringify({ title, head: branch, base: repo.base, body }) });
      prNumber = pr?.number;
    }
    return saveState(specId, {
      state: 'open', path, branch, prNumber, repoFullName: repo.fullName, headSha, revision: built.revision,
      contentHash: built.copy.contentHash, metadataHash: built.copy.metadataHash, publication,
      ...(spec.repoCopy?.publishAnyway ? { publishAnyway: spec.repoCopy.publishAnyway } : {}), updatedAt: at(),
    });
  } catch (err) {
    return saveState(specId, { ...(spec.repoCopy ?? {}), state: 'failed', error: errMsg(err), updatedAt: at() });
  }
}

/**
 * CI finished on a PR. When it is a spec's generated PR, apply the exception
 * (R-35): land it when green and its head is the generator's commit, refuse it
 * when the head is anyone else's (AC-97), and record the red check when it
 * fails (AC-79). Returns what it did, or null when the PR is not a generated copy.
 */
export async function landSpecRepoCopy(
  e: { repoFullName: string; prNumber: number; headSha: string; conclusion: string | null; installationId: number },
  deps: Pick<RepoCopyDeps, 'api' | 'now'> = defaultRepoCopyDeps,
): Promise<{ specId: string; outcome: 'merged' | 'refused' | 'behind' | 'waiting' | 'stale' | 'kept_private' } | null> {
  const [spec] = await db.select({ id: specs.id, repoCopy: specs.repoCopy }).from(specs)
    .where(and(sql`${specs.repoCopy}->>'repoFullName' = ${e.repoFullName}`, sql`(${specs.repoCopy}->>'prNumber')::int = ${e.prNumber}`)).limit(1);
  const rc = spec?.repoCopy;
  if (!spec || !rc || rc.state === 'merged') return null;
  // A later decision kept this spec private: its old PR never lands under the exception (Slice 14).
  if (rc.state === 'private') return { specId: spec.id, outcome: 'kept_private' };
  const at = deps.now().toISOString();
  const pr = await deps.api(e.installationId, `/repos/${e.repoFullName}/pulls/${e.prNumber}`);
  const liveHead: string | undefined = pr?.head?.sha;
  if (pr?.state !== 'open') return { specId: spec.id, outcome: 'stale' };
  if (liveHead !== e.headSha) return { specId: spec.id, outcome: 'stale' };
  if (liveHead !== rc.headSha) {
    await saveState(spec.id, { ...rc, state: 'refused', error: 'the head commit is not the generator\'s, so it does not land without review', updatedAt: at });
    return { specId: spec.id, outcome: 'refused' };
  }
  if (e.conclusion === 'failure' || e.conclusion === 'timed_out' || e.conclusion === 'cancelled' || e.conclusion === 'action_required') {
    const runs = await deps.api(e.installationId, `/repos/${e.repoFullName}/commits/${liveHead}/check-runs?per_page=100`).catch(() => null);
    const failing = (runs?.check_runs ?? []).find((r: { conclusion?: string }) => r.conclusion && !['success', 'skipped', 'neutral'].includes(r.conclusion));
    await saveState(spec.id, { ...rc, state: 'behind', failingCheck: failing?.name ?? 'a CI check', updatedAt: at });
    return { specId: spec.id, outcome: 'behind' };
  }
  if (e.conclusion !== 'success') return { specId: spec.id, outcome: 'waiting' };
  const suites = await deps.api(e.installationId, `/repos/${e.repoFullName}/commits/${liveHead}/check-suites`).catch(() => null);
  if (!checkSuitesAllPassed((suites?.check_suites ?? []) as CheckSuiteSummary[])) return { specId: spec.id, outcome: 'waiting' };
  try {
    await deps.api(e.installationId, `/repos/${e.repoFullName}/pulls/${e.prNumber}/merge`, {
      method: 'PUT', body: JSON.stringify({ sha: liveHead, merge_method: 'squash' }),
    });
  } catch (err) {
    await saveState(spec.id, { ...rc, state: 'behind', failingCheck: `merge refused: ${errMsg(err).slice(0, 120)}`, updatedAt: at });
    return { specId: spec.id, outcome: 'behind' };
  }
  await saveState(spec.id, { ...rc, state: 'merged', failingCheck: undefined, error: undefined, updatedAt: at });
  return { specId: spec.id, outcome: 'merged' };
}

// ── Publication (Slice 14) ──────────────────────────────────────────────────

/** Rules a person's "Publish anyway" cannot pass: the text itself, no policy, or a person's own private mark. */
export const HARD_KEEP_PRIVATE = new Set(['rule_prod_data', 'rule_no_policy', 'rule_marked_private']);

async function publicationSlot(deps: Pick<RepoCopyDeps, 'decide'>): Promise<PublicationDecide> {
  return deps.decide ?? (await import('@/modules')).SPEC_PUBLICATION_DECIDE;
}

/** Is the linked repo private? A read; null when it cannot be told. */
async function repoIsPrivate(workspaceId: string, deps: RepoCopyDeps): Promise<boolean | null> {
  try {
    const repo = await deps.repo(workspaceId);
    if (!repo) return null;
    const meta = await deps.api(repo.installationId, `/repos/${repo.fullName}`);
    return typeof meta?.private === 'boolean' ? meta.private : null;
  } catch {
    return null;
  }
}

/**
 * Publish or keep private one approved revision (R-67), on the copy's exact
 * text. A person's "Publish anyway" for this revision publishes past the model,
 * never past a hard rule. Never throws: a failure keeps it private.
 */
export async function decideSpecPublication(spec: SpecRow, built: Extract<BuiltCopy, { ok: true }>, deps: RepoCopyDeps): Promise<SpecPublicationDecision> {
  const decidedAt = deps.now().toISOString();
  try {
    const [policy, mark, repoPrivate] = await Promise.all([
      readPublicationPolicy(spec.workspaceId, spec.id), publicationMark(spec.id), repoIsPrivate(spec.workspaceId, deps),
    ]);
    const decide = await publicationSlot(deps);
    const out = await decide({
      workspaceId: spec.workspaceId, subjectId: spec.id, text: built.copy.text,
      destination: { kind: 'repo_spec_copy', label: `the repo${repoPrivate === false ? ', which is public' : ''}, as ${built.path}`, private: repoPrivate },
      policy: policy ? { version: policy.version, text: policy.text, lines: policy.lines } : null,
      mark: mark?.mark ?? null, markFrom: mark?.from,
    });
    const anyway = spec.repoCopy?.publishAnyway;
    if (!out.publish && anyway && anyway.revision === built.revision && !HARD_KEEP_PRIVATE.has(out.reasonCode)) {
      return { publish: true, source: 'person', reasonCode: 'person_published_anyway', reason: 'Published: a person published it anyway.', policyVersion: out.policyVersion, decisionRecordId: out.decisionRecordId, revision: built.revision, decidedAt };
    }
    return {
      publish: out.publish, source: out.source, reasonCode: out.reasonCode, reason: out.reason, ...(out.line ? { line: out.line } : {}),
      policyVersion: out.policyVersion, confidence: out.confidence, model: out.model, decisionRecordId: out.decisionRecordId,
      revision: built.revision, decidedAt,
    };
  } catch (err) {
    console.warn('[living-specs] publication decision failed (kept private):', errMsg(err));
    return { publish: false, source: 'fallback', reasonCode: 'fallback_error', reason: 'Not published: no decision model could read it against the policy, so it stays in buildd.', policyVersion: null, revision: built.revision, decidedAt };
  }
}

const COPY_GONE = 'the copy is no longer in the repo';
/** A copy of this spec landed in the repo and no removal has been opened or found unnecessary. */
const copyInRepo = (rc: SpecRepoCopyState | null | undefined): boolean => !!rc?.path && (rc.state === 'merged' || (!!rc.removal && rc.removal.error !== COPY_GONE));

/**
 * Keep a revision private (R-68): no copy, no GitHub write. A copy that already
 * landed is listed with a removal PR (R-70), unless one is open for it.
 */
async function keepPrivate(spec: SpecRow, publication: SpecPublicationDecision, deps: RepoCopyDeps): Promise<SpecRepoCopyState> {
  const prev = spec.repoCopy ?? null;
  const { state: _s, error: _e, failingCheck: _f, ...kept } = prev ?? ({} as Partial<SpecRepoCopyState>);
  const state: SpecRepoCopyState = { ...kept, state: 'private', publication, updatedAt: deps.now().toISOString() };
  const saved = await saveState(spec.id, state);
  if (copyInRepo(prev) && !prev?.removal?.prNumber) {
    await openRemovalPr(spec.workspaceId, [{ specId: spec.id, path: prev!.path! }], deps);
    const [after] = await db.select({ repoCopy: specs.repoCopy }).from(specs).where(eq(specs.id, spec.id)).limit(1);
    return after?.repoCopy ?? saved;
  }
  return saved;
}

/**
 * One PR removing the copies of specs the policy now keeps private (R-70). It
 * lands only when a person merges it; buildd deletes nothing on its own, and
 * the PR says that removal does not erase the repo's history. Records the PR
 * (or the error) on each spec. Never throws.
 */
export async function openRemovalPr(workspaceId: string, entries: Array<{ specId: string; path: string }>, deps: RepoCopyDeps = defaultRepoCopyDeps): Promise<number | null> {
  if (!entries.length) return null;
  const listedAt = deps.now().toISOString();
  const record = async (removal: { prNumber?: number; branch?: string; error?: string }, which = entries) => {
    for (const e of which) {
      await db.execute(sql`UPDATE specs SET repo_copy = coalesce(repo_copy, '{}'::jsonb) || jsonb_build_object('removal', ${JSON.stringify({ path: e.path, listedAt, ...removal })}::jsonb) WHERE id = ${e.specId}::uuid`);
    }
  };
  try {
    const repo = await readRepoState(workspaceId, deps, false);
    if ('error' in repo) { await record({ error: repo.error }); return null; }
    const names = new Set(entries.map((e) => e.path.slice('docs/specs/'.length)));
    const present = entries.filter((e) => repo.specFiles.has(e.path.slice('docs/specs/'.length)));
    const absent = entries.filter((e) => !present.includes(e));
    if (absent.length) await record({ error: COPY_GONE }, absent);
    if (!present.length) return null;
    const remaining = new Map([...repo.specFiles].filter(([f]) => !names.has(f)));
    const indexed: IndexedSpec[] = [...remaining.keys()].filter((f) => !SPEC_META_FILES.has(f)).sort().map((file) => ({
      file, slug: file.replace(/\.md$/, ''), fm: parseSpecFrontmatter(remaining.get(file)!).fm ?? {},
    }));
    const tree: Array<Record<string, unknown>> = present.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: null }));
    if (repo.specFiles.has('INDEX.md')) tree.push({ path: 'docs/specs/INDEX.md', mode: '100644', type: 'blob', content: buildSpecIndex(indexed) });
    const { api } = deps;
    const t = await api(repo.installationId, `/repos/${repo.fullName}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: repo.baseTreeSha, tree }) });
    const shorts = present.map((e) => e.path.slice('docs/specs/'.length)).sort();
    const commit = await api(repo.installationId, `/repos/${repo.fullName}/git/commits`, {
      method: 'POST', body: JSON.stringify({ message: `docs(specs): remove ${shorts.join(', ')}, which the publication policy keeps private`, tree: t?.sha, parents: [repo.baseSha] }),
    });
    if (!commit?.sha) throw new Error('the removal commit was not created');
    const branch = `buildd/spec-copy-removal-${String(commit.sha).slice(0, 8)}`;
    await api(repo.installationId, `/repos/${repo.fullName}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
    const body = [
      'The workspace\'s publication policy now keeps these specs in buildd, so their repo copies should go:',
      '',
      ...shorts.map((f) => `- \`docs/specs/${f}\``),
      '',
      'buildd never removes a file on its own: nothing changes in the repo until a person merges this PR. Removing a file does not erase it from the repo\'s history.',
    ].join('\n');
    const pr = await api(repo.installationId, `/repos/${repo.fullName}/pulls`, { method: 'POST', body: JSON.stringify({ title: 'docs(specs): remove copies the publication policy keeps private', head: branch, base: repo.base, body }) });
    await record({ prNumber: pr?.number, branch }, present);
    return pr?.number ?? null;
  } catch (err) {
    await record({ error: errMsg(err) });
    return null;
  }
}

/**
 * A new policy revision was approved (R-70): re-decide every approved spec in
 * the workspace. Nothing is published here; a spec the policy now allows is
 * published on its next approval. Specs whose copies are in the repo and are
 * now kept private are listed, with one removal PR. Never throws.
 */
export async function redecidePublication(workspaceId: string, deps: RepoCopyDeps = defaultRepoCopyDeps): Promise<{ decided: number; removals: string[]; prNumber: number | null }> {
  const out = { decided: 0, removals: [] as string[], prNumber: null as number | null };
  try {
    const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!nativeSourceOn(ws?.gitConfig)) return out;
    const rows = await db.select().from(specs).where(and(eq(specs.workspaceId, workspaceId), sql`${specs.approvedRevision} IS NOT NULL`, sql`${specs.scope} <> 'product'`)).limit(500);
    const gone: Array<{ specId: string; path: string }> = [];
    for (const spec of rows) {
      if (spec.repoSource?.state === 'imported') continue;
      const built = await buildSpecRepoCopy(spec, { now: deps.now() });
      if (!built.ok) continue;
      const publication = await decideSpecPublication(spec, built, deps);
      out.decided++;
      const rc = spec.repoCopy ?? null;
      if (publication.publish) {
        // Allowed now: recorded, written on the next approval.
        if (rc?.state === 'private') await saveState(spec.id, { ...rc, publication, updatedAt: deps.now().toISOString() });
        continue;
      }
      const { state: _s, error: _e, failingCheck: _f, ...kept } = rc ?? ({} as Partial<SpecRepoCopyState>);
      await saveState(spec.id, { ...kept, state: 'private', publication, updatedAt: deps.now().toISOString() });
      if (copyInRepo(rc) && !rc?.removal?.prNumber) gone.push({ specId: spec.id, path: rc!.path! });
    }
    out.removals = gone.map((g) => g.path);
    out.prNumber = await openRemovalPr(workspaceId, gone, deps);
  } catch (err) {
    console.warn('[living-specs] publication re-decision failed:', errMsg(err));
  }
  return out;
}

/**
 * "Publish anyway" (R-68): a person who may approve specs here publishes a
 * kept-private revision past the model. Never past a production-data hit, a
 * missing policy or a private mark. Recorded as an override on the decision
 * that kept it private, then the copy is written.
 */
export async function publishSpecAnyway(caller: SpecCaller, specId: string, deps: RepoCopyDeps = defaultRepoCopyDeps): Promise<{ ok: true; repoCopy: SpecRepoCopyState | null } | SpecError> {
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  const { reach } = await import('./store');
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  if (caller.kind !== 'user') return fail(403, 'Publishing a spec the policy kept private is a person\'s call, from the spec page.');
  const { specApprover } = await import('./approval');
  const person = await specApprover(caller, spec.workspaceId);
  if (!person) return fail(403, 'Only someone who may approve specs here can publish one anyway.');
  const rc = spec.repoCopy;
  if (rc?.state !== 'private' || !rc.publication || spec.approvedRevision == null) return fail(409, 'This spec is not being kept private, so there is nothing to publish anyway.');
  if (HARD_KEEP_PRIVATE.has(rc.publication.reasonCode)) return fail(409, rc.publication.reason);
  const anyway = { by: `user:${person}`, at: deps.now().toISOString(), revision: spec.approvedRevision };
  await saveState(spec.id, { ...rc, publishAnyway: anyway, updatedAt: anyway.at });
  if (rc.publication.decisionRecordId) {
    const { SPEC_PUBLICATION_OVERRIDE } = await import('@/modules');
    await SPEC_PUBLICATION_OVERRIDE(rc.publication.decisionRecordId, { revision: anyway.revision }, anyway.by).catch(() => {});
  }
  return { ok: true, repoCopy: await fileSpecRepoCopy(spec.id, deps) };
}

// ── Before approval (R-34) ──────────────────────────────────────────────────

export interface PreflightCheck {
  name: 'specs:lint' | 'public-docs:check' | 'no-prod-data';
  ok: boolean;
  messages: string[];
  /** What this run could not check. */
  note?: string;
}
export type RepoCopyPreflight =
  | { state: 'off' }
  | { state: 'not_generated'; message: string }
  | { state: 'ran'; path: string; checks: PreflightCheck[] };

/** Directories `scripts/check-public-docs.ts` keeps prose out of (GUARDED_DIRS). */
export const PUBLIC_DOCS_GUARDED_DIRS = ['docs/design', 'docs/plans', 'docs/reports'] as const;

/**
 * Run the repo checks on the would-be copy of `revision` (R-34): `specs:lint`
 * (the same functions, over the repo's specs with this copy in place),
 * `public-docs:check` and no-prod-data without its identifier half. Warns,
 * never blocks: the caller only shows the result.
 */
export async function repoCopyPreflight(spec: SpecRow, revision: number, deps: RepoCopyDeps = defaultRepoCopyDeps): Promise<RepoCopyPreflight> {
  const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, spec.workspaceId)).limit(1);
  if (!nativeSourceOn(ws?.gitConfig)) return { state: 'off' };
  const built = await buildSpecRepoCopy(spec, { revision, now: deps.now() });
  if (!built.ok) return { state: 'not_generated', message: built.message };
  let repo: RepoState | { error: string };
  try {
    repo = await readRepoState(spec.workspaceId, deps, true);
  } catch (err) {
    repo = { error: `GitHub could not be read: ${errMsg(err)}` };
  }
  const offline = 'error' in repo;
  const state: Pick<RepoState, 'specFiles' | 'checkSpecsSource' | 'paths'> = 'error' in repo ? { specFiles: new Map<string, string>(), checkSpecsSource: null, paths: null } : repo;
  const path = offline ? built.path : await choosePath(built, spec.repoCopy?.path ?? confirmedImportPath(spec), state.specFiles);
  const { domains, indexed } = generatedFiles(built, path, state);
  const slug = path.slice('docs/specs/'.length).replace(/\.md$/, '');
  const { fm, body } = parseSpecFrontmatter(built.copy.text);
  const paths = state.paths;
  const lint = lintSpecFile(slug, fm, body, { domains, exists: (p) => (paths ? paths.has(p) : true), now: deps.now().getTime() });
  const cross = offline ? [] : crossCheckSpecs(indexed).filter((m) => m.includes(`${slug}.md`));
  const lintMessages = [...lint.errors, ...cross];
  const notes: string[] = [];
  if (offline) notes.push(`${(repo as { error: string }).error}; related specs and paths were not checked`);
  else if (!paths) notes.push('the repo tree was too large to read whole, so paths were not checked');
  const guarded = PUBLIC_DOCS_GUARDED_DIRS.find((d) => path.startsWith(`${d}/`));
  const prod = scanForProdData(built.copy.text, { code: true });
  return {
    state: 'ran', path,
    checks: [
      { name: 'specs:lint', ok: lintMessages.length === 0, messages: [...lintMessages, ...lint.warnings.map((w) => `warning: ${w}`)], ...(notes.length ? { note: notes.join('; ') } : {}) },
      { name: 'public-docs:check', ok: !guarded, messages: guarded ? [`${path} is under ${guarded}, which keeps no prose in the public repo`] : [] },
      { name: 'no-prod-data', ok: prod.length === 0, messages: prod, note: 'The personal-handle and private-repo half runs only in CI, which holds its pattern; the generated PR\'s own run is the first full check.' },
    ],
  };
}

/** The spec page's source line (R-13) and how the repo copy stands (AC-79). */
export function repoCopyLine(on: boolean, rc: SpecRepoCopyState | null | undefined, approved: boolean, imported?: SpecRepoSource | null): { source: string; copy: string | null; behind: boolean; publishAnyway?: boolean } | null {
  // R-13: an unconfirmed import names its repo file as the source, opted in or not.
  if (imported?.state === 'imported') {
    return { source: `Imported from ${imported.path}@${imported.commitSha.slice(0, 7)}, waiting for confirmation`, copy: on ? 'No repo copy is written until a person confirms the import; the repo file stays the source.' : null, behind: false };
  }
  if (!on) return null;
  if (!rc) return { source: 'Source: buildd', copy: approved ? 'No repo copy written yet.' : 'A repo copy is written when a revision is approved.', behind: false };
  const at = rc.path ? `, repo copy at ${rc.path}` : '';
  const source = `Source: buildd${at}`;
  switch (rc.state) {
    case 'merged': return { source, copy: `Repo copy is up to date at revision ${rc.revision}.`, behind: false };
    case 'open': return { source, copy: `Repo copy of revision ${rc.revision} is waiting on CI in PR #${rc.prNumber}.`, behind: false };
    case 'behind': return { source, copy: `Repo copy is behind: ${rc.failingCheck ?? 'a check'} failed on PR #${rc.prNumber}. The approval stands; fix it with a new revision or a metadata change.`, behind: true };
    case 'refused': return { source, copy: `Repo copy is behind: PR #${rc.prNumber} has a commit buildd did not write, so it does not land without review.`, behind: true };
    case 'unfiled': return { source, copy: 'No repo copy: file this spec under an area first, which gives it its domain.', behind: true };
    case 'failed': return { source, copy: `Repo copy is behind: ${rc.error ?? 'the PR could not be written'}.`, behind: true };
    case 'private': {
      const p = rc.publication;
      const why = p?.publish ? 'The publication policy now allows this spec; its repo copy is written on its next approval.' : (p?.reason ?? 'Not published: the publication policy keeps it in buildd.');
      const r = rc.removal;
      const removal = !r ? (rc.prNumber && !p?.publish ? ` PR #${rc.prNumber} holds an earlier copy and will not land; close it.` : '')
        : r.error === COPY_GONE ? ''
        : r.prNumber ? ` Its earlier copy is still in the repo at ${r.path}; PR #${r.prNumber} removes it once a person merges it. Removing it does not erase it from the repo's history.`
          : ` Its earlier copy is still in the repo at ${r.path}, and the PR to remove it could not be opened${r.error ? ` (${r.error})` : ''}.`;
      return { source: 'Source: buildd', copy: `${why}${removal}`, behind: !!r && r.error !== COPY_GONE, publishAnyway: !!p && !p.publish && !HARD_KEEP_PRIVATE.has(p.reasonCode) };
    }
  }
}
