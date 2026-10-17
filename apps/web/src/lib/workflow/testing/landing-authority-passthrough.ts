/**
 * For route and door tests that mock `db` and `@/lib/github`: the landing
 * authority's own behaviour is pinned in `workflow/landing-authority.test.ts`
 * and `tests/db/review-findings.test.ts`, so here it passes and merges through
 * whatever `mergePullRequest` the test installed.
 *
 *   mock.module('@/lib/workflow/landing-authority', () => landingAuthorityPassthrough());
 */
export function landingAuthorityPassthrough() {
  return {
    judgeLanding: () => ({ blocks: false as const }),
    landingAuthority: async () => ({ blocks: false as const }),
    mergeWithAuthority: async (p: { installationId: number; repoFullName: string; prNumber: number; method: 'merge' | 'squash' | 'rebase'; headSha: string }) =>
      (await import('@/lib/github')).mergePullRequest(p.installationId, p.repoFullName, p.prNumber, p.method, p.headSha),
  };
}
