/**
 * Shared version cache — resolves a branch's HEAD commit SHA from the GitHub
 * API with a 5-minute in-memory TTL, **keyed by branch**. Used by both the
 * public /api/version endpoint and the heartbeat route.
 *
 * Why per-branch: the cache used to resolve one hardcoded ref and hand it to
 * every caller. The heartbeat returns that SHA to runners as `latestCommit`,
 * and a runner pinned to a different branch (`BUILDD_BRANCH`) resets to
 * `origin/<its branch>` — so it was being told to update to a commit that is
 * not an ancestor of the branch it tracks. It could never reach the target and
 * therefore could never stop being "behind".
 */

const GITHUB_REPO = 'buildd-ai/buildd';

/**
 * The ref resolved when a caller names no branch. Unchanged so `/api/version`
 * (and any runner too old to report a branch) behaves exactly as before.
 */
export const DEFAULT_VERSION_BRANCH = 'dev';

/**
 * Branches this cache will resolve. The requested branch arrives in a runner
 * heartbeat body — i.e. it is client-supplied — and is interpolated straight
 * into a GitHub API URL. Unvalidated that is two problems at once: an unbounded
 * cache key, and an outbound-request injection surface (`../../..` walks out of
 * the commits endpoint entirely). An allowlist, not sanitisation: the set of
 * branches a runner may legitimately track is small and known.
 */
export const ALLOWED_VERSION_BRANCHES = ['main', 'dev'] as const;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface VersionInfo {
  latestCommit: string;
  latestTag: string | null;
  updatedAt: string; // ISO timestamp
  /** Which ref `latestCommit` is the head of — after allowlist resolution. */
  branch: string;
}

/**
 * Resolves a requested branch to one this cache will actually fetch, falling
 * back to the default for anything unlisted (including non-strings).
 */
export function resolveVersionBranch(requested?: string | null): string {
  return typeof requested === 'string' && (ALLOWED_VERSION_BRANCHES as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_VERSION_BRANCH;
}

interface CacheEntry {
  info: VersionInfo;
  at: number;
}

// One entry per resolved branch. Bounded by the allowlist above, so this can
// never grow with client input.
const cache = new Map<string, CacheEntry>();

function githubHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'buildd-version-check',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

async function fetchFromGitHub(branch: string): Promise<VersionInfo> {
  // `branch` is allowlist-resolved before it reaches here — never raw input.
  const commitRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/commits/${branch}`,
    {
      headers: githubHeaders(),
      // Short timeout to avoid blocking callers
      signal: AbortSignal.timeout(5000),
    },
  );

  if (!commitRes.ok) {
    throw new Error(`GitHub API error: ${commitRes.status}`);
  }

  const commitData = await commitRes.json();
  const latestCommit: string = commitData.sha;

  // Fetch latest tag (best-effort)
  let latestTag: string | null = null;
  try {
    const tagsRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`,
      {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (tagsRes.ok) {
      const tags = await tagsRes.json();
      if (tags.length > 0) {
        latestTag = tags[0].name;
      }
    }
  } catch {
    // Non-fatal — tag lookup is optional
  }

  return {
    latestCommit,
    latestTag,
    updatedAt: new Date().toISOString(),
    branch,
  };
}

/**
 * Latest commit on `branch` (default `DEFAULT_VERSION_BRANCH`).
 *
 * Validation happens here rather than at each call site so a new caller cannot
 * forget it. On failure a stale entry for **that same branch** is served if one
 * exists; another branch's entry is never substituted — that would reintroduce
 * the cross-branch SHA that caused the loop.
 */
export async function getLatestVersion(branch?: string | null): Promise<VersionInfo> {
  const resolved = resolveVersionBranch(branch);
  const now = Date.now();
  const entry = cache.get(resolved);
  if (entry && now - entry.at < CACHE_TTL_MS) {
    return entry.info;
  }

  try {
    const info = await fetchFromGitHub(resolved);
    cache.set(resolved, { info, at: now });
    return info;
  } catch (err) {
    // If a stale entry for this branch exists, return it rather than failing.
    if (entry) return entry.info;
    throw err;
  }
}

/** Test-only: drop every cached entry so a test starts from a cold cache. */
export function __resetVersionCacheForTests(): void {
  cache.clear();
}

/** Test-only: age every cached entry, to exercise the stale-fallback path. */
export function __ageVersionCacheForTests(ms: number): void {
  for (const entry of cache.values()) entry.at -= ms;
}
