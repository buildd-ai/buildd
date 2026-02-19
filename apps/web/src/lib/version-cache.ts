/**
 * Shared version cache — fetches the latest `dev` commit SHA from GitHub API
 * with a 5-minute in-memory TTL.  Used by both the public /api/version endpoint
 * and the heartbeat route.
 */

const GITHUB_REPO = 'buildd-ai/buildd';
const GITHUB_BRANCH = 'dev';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface VersionInfo {
  latestCommit: string;
  latestTag: string | null;
  updatedAt: string; // ISO timestamp
}

let cached: VersionInfo | null = null;
let cachedAt = 0;

async function fetchFromGitHub(): Promise<VersionInfo> {
  // Fetch latest commit on dev branch
  const commitRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
    {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'buildd-version-check',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
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
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'buildd-version-check',
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
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
  };
}

export async function getLatestVersion(): Promise<VersionInfo> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    cached = await fetchFromGitHub();
    cachedAt = now;
    return cached;
  } catch (err) {
    // If cache exists but is stale, return stale data rather than failing
    if (cached) return cached;
    throw err;
  }
}
