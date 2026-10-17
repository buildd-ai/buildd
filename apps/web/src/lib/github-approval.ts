import { githubApi } from './github';
import { getKey, setWithTtl, delKey } from './redis';
import { mapWithConcurrency } from '@/app/api/workers/claim/concurrency-limit';
import type { GithubApprovalFacts } from './reviewer-gate';

/** Live GitHub aggregate approval plus effective human reviews of the head. */
export async function readGithubApproval(
  installationId: number, repoFullName: string, prNumber: number,
  api: typeof githubApi = githubApi,
): Promise<GithubApprovalFacts> {
  return (await readLive(installationId, repoFullName, prNumber, api)).facts;
}

async function readLive(
  installationId: number, repoFullName: string, prNumber: number,
  api: typeof githubApi,
): Promise<{ facts: GithubApprovalFacts; head: string }> {
  const [owner, name] = repoFullName.split('/');
  let after: string | null = null;
  const latest = new Map<string, { state: string; commit?: { oid: string } }>();
  let reviewDecision: string | null = null;
  let head = '';
  do {
    const response = await api(installationId, '/graphql', {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ query: `query($owner:String!,$name:String!,$number:Int!,$after:String) {
        repository(owner:$owner,name:$name) { pullRequest(number:$number) {
          headRefOid reviewDecision reviews(first:100,after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes { state author { login __typename } commit { oid } }
          }
        } }
      }`, variables: { owner, name, number: prNumber, after } }),
    });
    const pr = response?.data?.repository?.pullRequest;
    if (response?.errors?.length || !pr) throw new Error('GitHub approval state unavailable');
    head = pr.headRefOid;
    reviewDecision = pr.reviewDecision ?? null;
    for (const review of pr.reviews.nodes) {
      if (review.author?.__typename !== 'User' || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
      latest.set(review.author.login, review);
    }
    after = pr.reviews.pageInfo?.hasNextPage ? pr.reviews.pageInfo.endCursor : null;
  } while (after);
  return { head, facts: { reviewDecision, humanApproved: [...latest.values()].some(r => r.state === 'APPROVED' && r.commit?.oid === head) } };
}

// ── Cache ────────────────────────────────────────────────────────────────────
// Home asks this for every open PR on every render; each answer is a GitHub
// GraphQL round trip awaited before the page responds. Nothing stores the
// effective review state (the pull_request_review webhook only records mission
// notes, and GitHub's reviewDecision depends on branch protection we never
// see), so the live answer is cached briefly instead.
//
// A stale approval on a new head must never read as approved. The live head is
// not known without asking GitHub, so an entry is bound to two things:
//   - the worker's last pushed commit at read time: a push by the worker moves
//     workers.lastCommitSha and misses the entry before any webhook arrives;
//   - the PR's webhooks: any pull_request action (synchronize from anyone,
//     including a platform base refresh) and any pull_request_review action
//     (submitted, dismissed, edited) deletes it.
// The TTL bounds a lost webhook. Home's use of these facts only picks a manual
// action label; merge doors re-read GitHub themselves.
export const GITHUB_APPROVAL_TTL_SEC = 60;
/** Concurrent GitHub lookups per Home render. */
export const GITHUB_APPROVAL_CONCURRENCY = 8;

export interface ApprovalCache {
  /** `undefined` = could not ask (fail open to a live read); `null` = no entry. */
  get<T>(key: string): Promise<T | null | undefined>;
  set<T>(key: string, value: T, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
}
const redisCache: ApprovalCache = { get: getKey, set: setWithTtl, del: delKey };

interface CachedApproval { facts: GithubApprovalFacts; head: string; workerSha: string | null }

export function githubApprovalCacheKey(repoFullName: string, prNumber: number): string {
  return `gh-approval:v1:${repoFullName.toLowerCase()}#${prNumber}`;
}

function isCachedApproval(v: unknown): v is CachedApproval {
  const e = v as CachedApproval | null;
  return !!e && typeof e === 'object' && typeof e.head === 'string' && e.head.length > 0
    && (e.workerSha === null || typeof e.workerSha === 'string')
    && !!e.facts && typeof e.facts.humanApproved === 'boolean'
    && (e.facts.reviewDecision === null || typeof e.facts.reviewDecision === 'string');
}

export async function readGithubApprovalCached(
  installationId: number, repoFullName: string, prNumber: number,
  opts: { workerSha: string | null; api?: typeof githubApi; cache?: ApprovalCache },
): Promise<GithubApprovalFacts> {
  const cache = opts.cache ?? redisCache;
  const key = githubApprovalCacheKey(repoFullName, prNumber);
  const workerSha = opts.workerSha ?? null;
  let hit: unknown;
  try { hit = await cache.get<CachedApproval>(key); } catch { hit = undefined; }
  if (isCachedApproval(hit) && hit.workerSha === workerSha) return hit.facts;
  const live = await readLive(installationId, repoFullName, prNumber, opts.api ?? githubApi);
  try {
    await cache.set<CachedApproval>(key, { facts: live.facts, head: live.head, workerSha }, GITHUB_APPROVAL_TTL_SEC);
  } catch { /* fail open: the live answer stands */ }
  return live.facts;
}

/** Drop a PR's cached approval: its head or its reviews changed on GitHub. */
export async function invalidateGithubApproval(
  repoFullName: string, prNumber: number, cache: ApprovalCache = redisCache,
): Promise<void> {
  try { await cache.del(githubApprovalCacheKey(repoFullName, prNumber)); } catch { /* TTL backstops */ }
}

/** One pass over every PR, at most `limit` lookups in flight. */
export async function loadGithubApprovals<T>(
  items: readonly T[], limit: number, fn: (item: T) => Promise<void>,
): Promise<void> {
  await mapWithConcurrency(items, limit, fn);
}
