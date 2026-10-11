/**
 * The SHA-aware changed-file scope of an open PR, for the claim route's
 * hold/start risk profile (packages/core/orchestration-claim-risk.ts
 * `EffectiveScope`, source `pr_diff_at_head`).
 *
 * A declared task manifest is what a holder said it might touch, often
 * inherited from older branch state; the PR's diff at its current head is what
 * it actually changes. The diff is keyed by (repo, PR, head, base): one cheap
 * `GET pulls/{n}` tells whether the cached list is still the PR's diff, and
 * only a moved head or base pays for a fresh pinned read
 * (`readPinnedPrScope`, the same reader the PR-scope reconciler uses).
 *
 * The claim loop's collector is synchronous and does no I/O, so the route
 * calls `prefetchPrDiffScopes` first and hands the result in. Anything short
 * of a whole, verified list is simply absent (the risk stays `uncertain`), and
 * a diff read at an older head is returned marked with the head it was read
 * at, so `effectiveScopeIsCurrent` refuses it. Never throws.
 */
import { readPinnedPrScope, type GithubGet } from '@buildd/core/pr-scope-read';

export interface PrDiffScope {
  /** Every path the PR changes at `headSha` (both sides of a rename). */
  paths: string[];
  /** The head the diff was read at. */
  headSha: string;
  /** The PR's head now. Differs from `headSha` when only a stale diff is known. */
  currentHeadSha: string;
  /** When this diff was last confirmed to be the PR's diff, ISO. */
  observedAt: string;
}

export interface PrDiffScopeDeps {
  resolveRepo: (workspaceId: string) => Promise<{ fullName: string; installationId: number } | null>;
  github: (installationId: number, path: string) => Promise<unknown>;
  now?: () => number;
  /** Bound on the whole prefetch: a slow GitHub must not hold a claim response. */
  timeoutMs?: number;
}

interface Entry { paths: string[]; headSha: string; baseSha: string }

const CACHE_MAX = 500;
const DEFAULT_TIMEOUT_MS = 4_000;
const cache = new Map<string, Entry>();

export function resetPrDiffScopeCache(): void {
  cache.clear();
}

const remember = (key: string, entry: Entry) => {
  cache.delete(key);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, entry);
};

async function resolveOne(
  get: GithubGet,
  repoFullName: string,
  prNumber: number,
  nowIso: string,
): Promise<PrDiffScope | null> {
  const key = `${repoFullName}#${prNumber}`;
  const pr = await get(`/repos/${repoFullName}/pulls/${prNumber}`) as
    { state?: string; merged?: boolean; head?: { sha?: unknown }; base?: { sha?: unknown } } | null;
  const head = pr?.head?.sha;
  const base = pr?.base?.sha;
  if (typeof head !== 'string' || !head || typeof base !== 'string' || !base) return null;
  if (pr?.state === 'closed' || pr?.merged === true) return null;

  const hit = cache.get(key);
  if (hit && hit.headSha === head && hit.baseSha === base) {
    return { paths: hit.paths, headSha: head, currentHeadSha: head, observedAt: nowIso };
  }
  const read = await readPinnedPrScope(get, { repoFullName, prNumber, expectedHeadSha: head });
  if (read.status === 'complete' && read.headSha === head) {
    remember(key, { paths: read.files, headSha: read.headSha, baseSha: read.baseSha });
    return { paths: read.files, headSha: read.headSha, currentHeadSha: head, observedAt: nowIso };
  }
  // Could not read the diff at the current head. An older diff is evidence of
  // nothing now; hand it back marked stale so the risk profile says so.
  if (hit) return { paths: hit.paths, headSha: hit.headSha, currentHeadSha: head, observedAt: nowIso };
  return null;
}

/** Current diff scope per PR number. A PR that could not be resolved is absent. */
export async function prefetchPrDiffScopes(
  input: { workspaceId: string; prNumbers: number[] },
  deps: PrDiffScopeDeps,
): Promise<Map<number, PrDiffScope>> {
  const out = new Map<number, PrDiffScope>();
  const prNumbers = [...new Set(input.prNumbers.filter(n => Number.isInteger(n) && n > 0))];
  if (prNumbers.length === 0) return out;
  const run = async () => {
    const repo = await deps.resolveRepo(input.workspaceId);
    if (!repo) return;
    const get: GithubGet = (path) => deps.github(repo.installationId, path);
    const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
    await Promise.all(prNumbers.map(async (n) => {
      try {
        const scope = await resolveOne(get, repo.fullName, n, nowIso);
        if (scope) out.set(n, scope);
      } catch (err) {
        console.warn(`[claim] PR diff scope for #${n} unavailable:`, (err as Error)?.message ?? err);
      }
    }));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    console.warn('[claim] PR diff scope prefetch failed:', (err as Error)?.message ?? err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // A timed-out run may still be writing; hand back only what is complete now.
  return new Map(out);
}

/** Production bindings. */
export async function defaultPrDiffScopeDeps(): Promise<PrDiffScopeDeps> {
  const [{ db }, schema, { eq }, { githubApi }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
    import('@/lib/github'),
  ]);
  return {
    github: (installationId, path) => githubApi(installationId, path),
    async resolveRepo(workspaceId) {
      const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, workspaceId), columns: { githubRepoId: true } });
      if (!ws?.githubRepoId) return null;
      const repo = await db.query.githubRepos.findFirst({ where: eq(schema.githubRepos.id, ws.githubRepoId), with: { installation: true } }) as
        { fullName: string; installation: { installationId: number } | null } | undefined;
      return repo?.installation ? { fullName: repo.fullName, installationId: repo.installation.installationId } : null;
    },
  };
}
