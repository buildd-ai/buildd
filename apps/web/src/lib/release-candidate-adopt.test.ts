/**
 * A release-candidate PR the release workflow opens directly on GitHub has no
 * buildd worker on its branch (`release/vX.Y.Z` was never a task's branch),
 * and `maybeAutoReviewUnownedPr` explicitly refuses to adopt it (a candidate
 * has its own gate, never an agent reviewer). Left there, `get_pr`/`merge_pr`
 * — keyed on `workers.prNumber` — answer "not found" for a PR that is open
 * and legitimate. `maybeAdoptReleaseCandidatePr` closes exactly that gap.
 * Everything here is injected; no DB, no GitHub.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { maybeAdoptReleaseCandidatePr, type ReleaseCandidateAdoptDeps } from './release-candidate-adopt';
import type { AutoReviewWorkspace } from './auto-review-unowned';

const ws = (over: Partial<AutoReviewWorkspace> = {}): AutoReviewWorkspace => ({
  id: 'ws-a', teamId: 'team-a', name: 'repo', repo: 'org/repo',
  githubRepoId: 'gr-1', githubInstallationId: 'gi-1',
  gitConfig: { defaultBranch: 'dev' },
  webhookConfig: null,
  releaseConfig: { candidate: { branches: ['release/v*'], authors: ['buildd-release[bot]'], prodBranch: 'main', sourceBranch: 'dev' } } as never,
  ...over,
});

const pr = (over: Record<string, unknown> = {}) => ({
  number: 6031, draft: false, title: 'release: v0.395.2', body: '<!-- release-candidate {} -->',
  html_url: 'https://github.com/org/repo/pull/6031',
  user: { login: 'buildd-release[bot]', type: 'Bot' },
  head: { sha: 'cand-sha', ref: 'release/v0.395.2', repo: { full_name: 'org/repo' } },
  base: { ref: 'main', repo: { full_name: 'org/repo' } },
  ...over,
});

let adopt: ReturnType<typeof mock>;
let owned: Set<number>;
let deps: ReleaseCandidateAdoptDeps;

beforeEach(() => {
  owned = new Set();
  adopt = mock(async (p: { prNumber: number }) => {
    owned.add(p.prNumber);
    return { adopted: true };
  });
  deps = {
    linkedWorkspaces: async () => [ws()],
    // A real `classifyReleasePr` only says 'candidate' for the exact test PR
    // shape above — anything else (wrong author, no metadata, moved head) is 'none'.
    classify: (_config, p) => ({
      kind: p.author === 'buildd-release[bot]' && p.headRef === 'release/v0.395.2' && p.body?.includes('release-candidate')
        ? 'candidate' : 'none',
    }),
    owningWorkerId: async (_w, n) => (owned.has(n) ? 'w-adopted' : null),
    adopt: adopt as unknown as ReleaseCandidateAdoptDeps['adopt'],
  };
});

const run = (over: { action?: string; pr?: Record<string, unknown> } = {}) =>
  maybeAdoptReleaseCandidatePr({
    action: over.action ?? 'opened', installationId: 7, repoFullName: 'org/repo',
    pr: (over.pr ?? pr()) as never,
  }, deps);

describe('maybeAdoptReleaseCandidatePr', () => {
  it('adopts a trusted release-candidate PR', async () => {
    expect(await run()).toBe('adopted');
    expect(adopt).toHaveBeenCalledTimes(1);
    const p = (adopt.mock.calls[0] as any[])[0];
    expect(p.workspaceId).toBe('ws-a');
    expect(p.installationId).toBe(7);
    expect(p.repoFullName).toBe('org/repo');
    expect(p.prNumber).toBe(6031);
    expect(p.pr.number).toBe(6031);
  });

  for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize']) {
    it(`runs on ${action}`, async () => {
      expect(await run({ action })).toBe('adopted');
    });
  }

  it('ignores every other action', async () => {
    for (const action of ['closed', 'edited', 'converted_to_draft', 'labeled']) {
      expect(await run({ action })).toBe('skipped_action');
    }
    expect(adopt).not.toHaveBeenCalled();
  });

  it('never adopts a PR merely shaped like a candidate (wrong author, unverified metadata)', async () => {
    expect(await run({ pr: pr({ user: { login: 'someone', type: 'User' } }) })).toBe('skipped_not_candidate');
    expect(await run({ pr: pr({ body: 'no metadata here' }) })).toBe('skipped_not_candidate');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('a duplicate webhook delivery adopts nothing a second time', async () => {
    expect(await run()).toBe('adopted');
    expect(await run()).toBe('already_owned');
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it('an ordinary PR (not release-shaped at all) is left alone', async () => {
    expect(await run({
      pr: pr({
        head: { sha: 'f1', ref: 'buildd/abc12345-fix', repo: { full_name: 'org/repo' } },
        base: { ref: 'dev', repo: { full_name: 'org/repo' } },
      }),
    })).toBe('skipped_not_candidate');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('an unlinked repo adopts nothing', async () => {
    deps.linkedWorkspaces = async () => [];
    expect(await run()).toBe('skipped_unlinked');
    expect(adopt).not.toHaveBeenCalled();
  });
});
