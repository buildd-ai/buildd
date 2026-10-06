import { githubApi } from './github';
import type { GithubApprovalFacts } from './reviewer-gate';

/** Live GitHub aggregate approval plus effective human reviews of the head. */
export async function readGithubApproval(
  installationId: number, repoFullName: string, prNumber: number,
  api: typeof githubApi = githubApi,
): Promise<GithubApprovalFacts> {
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
  return { reviewDecision, humanApproved: [...latest.values()].some(r => r.state === 'APPROVED' && r.commit?.oid === head) };
}
