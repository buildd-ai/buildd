/**
 * What review a frozen release candidate is owed (docs/specs/release-flow.md
 * AC-14, AC-25 to AC-27): none when every change is an approved PR on the
 * source branch, one over exactly the uncovered commits otherwise, and the
 * full review only when the proof cannot be read.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { candidateReviewScope, clearCandidateReviewMemo, deltaFiles } from './candidate-review';
import { COMPOSITION_BLOCK_START } from './composition-description';
import type { CompositionResult } from './review-composition';

const REPO = 'acme/widgets';
const CONFIG = {
  enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main',
  candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
} as const;
const body = (candidateSha: string, o: Record<string, unknown> = {}) => `Release v1.2.3\n<!-- release-candidate ${JSON.stringify({
  schema: 1, version: '1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: 'S9', candidateSha,
  baseRef: 'main', baseSha: 'B0', previousTag: 'v1.2.2', bump: 'minor', amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-10-23T10:01:15Z', ...o,
})} -->`;
const pull = (head: string, o: Record<string, unknown> = {}) => ({
  head: { ref: 'release/v1.2.3', sha: head, repo: { full_name: REPO } }, base: { ref: 'main', repo: { full_name: REPO } },
  user: { login: 'github-actions[bot]' }, body: body(head), ...o,
});
const input = { workspaceId: 'w1', installationId: 1, repoFullName: REPO, prNumber: 50, releaseConfig: CONFIG as never };
const p = (patch: string) => `@@ -1 +1 @@\n-old\n+${patch}`;

beforeEach(() => clearCandidateReviewMemo());

// ── A replay of the shapes in candidate v0.377.0 ─────────────────────────────
// main...AGG: a squash constituent that adds a migration (#11, approved), a
// direct autofix commit, a PR merged with a merge commit (#13, approved, one
// commit of its own), main merged back into dev after the last release, a
// second direct autofix commit, and the release-only commit. The aggregate is
// past GitHub's file cap.
function releaseApi(writes: Array<{ path: string; body: string }>) {
  const MIG = 'packages/core/drizzle/20261023000000_x/migration.sql';
  const commitFiles: Record<string, unknown[]> = {
    S1: [{ filename: MIG, status: 'added', patch: '@@ -0,0 +1 @@\n+ALTER TABLE t DROP COLUMN c;' }],
    D1: [{ filename: 'apps/runner/probe.test.ts', status: 'modified', patch: p('retry on EBUSY') }],
    K1: [{ filename: 'apps/runner/wsl.ts', status: 'modified', patch: p('wsl') }],
    M13: [{ filename: 'apps/runner/wsl.ts', status: 'modified', patch: p('wsl') }],
    SYNC: [
      { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -7 +7,2 @@\n+## [1.2.2] - 2026-10-22' },
      { filename: 'apps/web/package.json', status: 'modified', patch: '@@ -2 +2 @@\n-  "version": "1.2.1",\n+  "version": "1.2.2",' },
    ],
    D2: [{ filename: 'apps/web/src/layout.tsx', status: 'modified', patch: p('read cookies with the user') }],
    V1: [{ filename: 'apps/web/package.json', status: 'modified', patch: '@@ -2 +2 @@\n-  "version": "1.2.2",\n+  "version": "1.2.3",' }, { filename: 'CHANGELOG.md', status: 'modified', patch: '@@ -1 +1 @@\n+## [1.2.3]' }],
  };
  const pulls: Record<string, unknown[]> = {
    S1: [{ number: 11, merged_at: '2026-10-22T00:00:00Z', base: { ref: 'dev' }, head: { sha: 'P11' } }],
    D1: [], D2: [], V1: [],
    K1: [{ number: 13, merged_at: '2026-10-22T00:00:00Z', base: { ref: 'dev' }, head: { sha: 'K1' } }],
    M13: [{ number: 13, merged_at: '2026-10-22T00:00:00Z', base: { ref: 'dev' }, head: { sha: 'K1' } }],
  };
  return async (_i: number, path: string, options?: RequestInit): Promise<unknown> => {
    if (path === `/repos/${REPO}/pulls/50`) {
      if (options?.method === 'PATCH') { writes.push({ path, body: JSON.parse(String(options.body)).body }); return {}; }
      return pull('AGG');
    }
    if (path.startsWith(`/repos/${REPO}/compare/main...AGG`)) return {
      merge_base_commit: { sha: 'B0' }, base_commit: { sha: 'B9' }, total_commits: 7,
      commits: [
        { sha: 'S1', parents: [{ sha: 'B0' }], commit: { message: 'feat: schema (#11)' } },
        { sha: 'D1', parents: [{ sha: 'S1' }], commit: { message: 'autofix: retry temp dir cleanup' } },
        { sha: 'K1', parents: [{ sha: 'B0' }], commit: { message: 'feat(runner): wsl setup' } },
        { sha: 'M13', parents: [{ sha: 'D1' }, { sha: 'K1' }], commit: { message: 'Merge pull request #13' } },
        { sha: 'SYNC', parents: [{ sha: 'M13' }, { sha: 'MAIN' }], commit: { message: "Merge branch 'main' into dev" } },
        { sha: 'D2', parents: [{ sha: 'SYNC' }], commit: { message: 'autofix: read cookies alongside the user' } },
        { sha: 'V1', parents: [{ sha: 'D2' }], commit: { message: 'chore: bump version to v1.2.3' } },
      ],
      // At GitHub's 300-file cap: the list may be cut.
      files: Array.from({ length: 300 }, (_, n) => ({ filename: `f${n}.ts` })),
    };
    const commit = /^\/repos\/acme\/widgets\/commits\/([A-Z0-9]+)$/.exec(path);
    if (commit) return { files: commitFiles[commit[1]] };
    const prs = /^\/repos\/acme\/widgets\/commits\/([A-Z0-9]+)\/pulls$/.exec(path);
    if (prs) return pulls[prs[1]];
    // Merge parents against the base tip: main's commit is in it, the PR's branch is not.
    if (path === `/repos/${REPO}/compare/MAIN...B9`) return { status: 'ahead' };
    if (path === `/repos/${REPO}/compare/K1...B9`) return { status: 'diverged' };
    // K1 is on #13's merged head (it is that head).
    if (path === `/repos/${REPO}/compare/K1...K1`) return { status: 'identical' };
    // What each approved head changed, read independently of what landed.
    if (path === `/repos/${REPO}/compare/B0...P11`) return { files: commitFiles.S1 };
    if (path === `/repos/${REPO}/compare/D1...K1`) return { files: commitFiles.M13 };
    throw new Error(`unexpected ${path}`);
  };
}
const ledger = async () => ({
  rows: [11, 13].map((n) => ({
    id: `d-${n}`, pr_number: n, approved_heads: [n === 11 ? 'P11' : 'K1'],
    rounds: [{ id: `r-${n}`, head_sha: n === 11 ? 'P11' : 'K1', status: 'decided', effective_verdict: 'approve' }],
  })),
});

describe('candidateReviewScope: a replay of a real candidate', () => {
  test('(b) only the direct commits are owed a review; the migration constituent, the merge-commit PR and the merge back are covered', async () => {
    const writes: Array<{ path: string; body: string }> = [];
    const scope = await candidateReviewScope(input, { api: releaseApi(writes), exec: ledger as never });
    expect(scope).toMatchObject({ kind: 'delta', headSha: 'AGG', paths: ['apps/runner/probe.test.ts', 'apps/web/src/layout.tsx'] });
    if (scope.kind !== 'delta') throw new Error('unreachable');
    expect(scope.commits).toEqual([
      { sha: 'D1', reason: 'direct_commit', paths: ['apps/runner/probe.test.ts'] },
      { sha: 'D2', reason: 'direct_commit', paths: ['apps/web/src/layout.tsx'] },
    ]);
    // (c) and the size cap: nothing the reviewer is shown comes from a reviewed constituent.
    expect(scope.files.map((f) => f.filename)).toEqual(['apps/runner/probe.test.ts', 'apps/web/src/layout.tsx']);
    expect(scope.files[0]).toMatchObject({ additions: 1, deletions: 1 });
    // The description reports it; the metadata that makes it a candidate is kept.
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toContain(COMPOSITION_BLOCK_START);
    expect(writes[0].body).toContain('<!-- release-candidate ');
  });

  test('the same head is answered once: a second landing pass reads nothing from GitHub', async () => {
    const writes: Array<{ path: string; body: string }> = [];
    const reads: string[] = [];
    const api = releaseApi(writes);
    const counting = async (i: number, path: string, o?: RequestInit) => { reads.push(path); return api(i, path, o); };
    await candidateReviewScope(input, { api: counting, exec: ledger as never });
    const before = reads.length;
    await candidateReviewScope(input, { api: counting, exec: ledger as never });
    expect(reads.length - before).toBe(1); // the live PR read only
  });
});

describe('candidateReviewScope: what it claims', () => {
  const composed: CompositionResult = {
    attestation: {
      repoFullName: REPO, prNumber: 50, baseSha: 'B0', aggregateHeadSha: 'X', method: 'patch_set_equal', verifiedAt: 'now', verifier: 'kernel',
      constituents: [{ deliveryId: 'd', roundId: 'r', prNumber: 11, reviewedHeadSha: 'P11', equivalentHeadShas: [], mergedHeadSha: 'P11', landedSha: 'S1', landedPatchId: 'x', reviewedPatchId: 'x' }],
      novelDelta: { result: 'none' },
    },
    constituentsEvidence: [], novelCommits: [],
  };

  test('(a) after an amendment the new head is composed afresh, and a fully composed head owes no reviewer', async () => {
    let head = 'AGG';
    const heads: string[] = [];
    const api = async (_i: number, path: string, o?: RequestInit) => (o?.method === 'PATCH' ? {} : path.endsWith('/pulls/50') ? pull(head, { body: body(head, head === 'AGG' ? {} : { amendment: 1, previousCandidateSha: 'AGG' }) }) : null);
    const collect = (async (q: { aggregateHeadSha: string; constituentBase?: string | null; aggregateFromCommits?: boolean }) => {
      heads.push(q.aggregateHeadSha);
      expect(q.constituentBase).toBe('dev');
      expect(q.aggregateFromCommits).toBe(true);
      return composed;
    }) as never;
    expect(await candidateReviewScope(input, { api, collect })).toEqual({ kind: 'composed', headSha: 'AGG', constituents: 1 });
    head = 'AMENDED';
    expect(await candidateReviewScope(input, { api, collect })).toEqual({ kind: 'composed', headSha: 'AMENDED', constituents: 1 });
    expect(heads).toEqual(['AGG', 'AMENDED']);
  });

  test('a candidate-shaped PR without provenance, or a head the metadata does not name, is not a candidate', async () => {
    const collect = (async () => { throw new Error('must not compose'); }) as never;
    for (const pr of [pull('AGG', { user: { login: 'mallory' } }), pull('AGG', { body: 'Release v1.2.3' }), pull('PUSHED', { body: body('AGG') })]) {
      const api = async () => pr;
      expect(await candidateReviewScope(input, { api, collect })).toEqual({ kind: 'not_candidate' });
    }
    expect(await candidateReviewScope({ ...input, releaseConfig: { ...CONFIG, candidate: undefined } as never }, { api: async () => pull('AGG'), collect })).toEqual({ kind: 'not_candidate' });
  });

  test('a composition it cannot read keeps the full review', async () => {
    const api = async (_i: number, path: string, o?: RequestInit) => (o?.method === 'PATCH' ? {} : path.endsWith('/pulls/50') ? pull('AGG') : null);
    const unverifiable = { ...composed, attestation: { ...composed.attestation, constituents: [], novelDelta: { result: 'unverifiable' as const, reason: 'commit_list_truncated' } } };
    expect(await candidateReviewScope(input, { api, collect: (async () => unverifiable) as never })).toEqual({ kind: 'unverifiable', headSha: 'AGG', reason: 'commit_list_truncated' });
    clearCandidateReviewMemo();
    expect(await candidateReviewScope(input, { api, collect: (async () => { throw new Error('rate limited'); }) as never })).toMatchObject({ kind: 'unverifiable', reason: expect.stringContaining('rate limited') });
  });
});

describe('deltaFiles', () => {
  test('one entry per delta path, counts summed across its commits (no single patch then), a path with no readable diff still listed', () => {
    const result = {
      novelCommits: [{ sha: 'A', reason: 'direct_commit', paths: ['x.ts'] }, { sha: 'B', reason: 'direct_commit', paths: ['x.ts', 'y.ts'] }],
      novelDiffs: { A: [{ filename: 'x.ts', status: 'modified', patch: '@@\n+a\n-b' }], B: [{ filename: 'x.ts', status: 'modified', patch: '@@\n+c' }] },
    } as unknown as CompositionResult;
    expect(deltaFiles(result, ['x.ts', 'y.ts'])).toEqual([
      { filename: 'x.ts', status: 'modified', additions: 2, deletions: 1 },
      { filename: 'y.ts', status: 'modified', additions: 0, deletions: 0 },
    ]);
  });
});
