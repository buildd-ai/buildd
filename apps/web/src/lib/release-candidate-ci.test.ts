/**
 * A red frozen release candidate is never repaired on its own branch: the fix
 * goes to the branch it was cut from, and the candidate is amended afterwards.
 */
import { describe, it, expect } from 'bun:test';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import {
  buildReleaseCandidateFixTask,
  classifyCiRedReleasePr,
  releaseCandidateBranchPushRefusal,
} from './release-candidate-ci';

const config: WorkspaceReleaseConfig = {
  enabled: true,
  strategy: 'workflow_dispatch',
  prodBranch: 'main',
  candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
} as WorkspaceReleaseConfig;

const meta = {
  schema: 1, version: '1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: 'src-sha',
  candidateSha: 'cand-sha', baseRef: 'main', baseSha: 'base-sha', previousTag: 'v1.2.2',
  amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z',
};

const pr = (over: Record<string, unknown> = {}) => ({
  headRef: 'release/v1.2.3',
  baseRef: 'main',
  headSha: 'cand-sha',
  author: 'github-actions[bot]',
  headRepoFullName: 'acme/app',
  baseRepoFullName: 'acme/app',
  body: `Release\n\n<!-- release-candidate ${JSON.stringify(meta)} -->`,
  ...over,
});

describe('classifyCiRedReleasePr', () => {
  it('a trusted candidate at its recorded head is a candidate with its source branch', () => {
    expect(classifyCiRedReleasePr(config, pr())).toMatchObject({ kind: 'candidate', version: '1.2.3', sourceBranch: 'dev', headRef: 'release/v1.2.3' });
  });

  it('a candidate whose head moved off the recorded SHA is still never pushed to', () => {
    expect(classifyCiRedReleasePr(config, pr({ headSha: 'pushed-over' }))).toEqual({ kind: 'candidate_shaped', reason: 'candidate_sha_moved' });
  });

  it('an untrusted author on a candidate-shaped branch is never pushed to either', () => {
    expect(classifyCiRedReleasePr(config, pr({ author: 'someone' }))).toEqual({ kind: 'candidate_shaped', reason: 'author_not_trusted' });
  });

  it('an ordinary PR, a legacy dev to main PR, or a workspace without candidates is ordinary', () => {
    expect(classifyCiRedReleasePr(config, pr({ headRef: 'buildd/abc-fix', baseRef: 'dev' }))).toEqual({ kind: 'ordinary' });
    expect(classifyCiRedReleasePr({ ...config, candidate: undefined, releaseBranch: 'dev' } as WorkspaceReleaseConfig, pr({ headRef: 'dev' }))).toEqual({ kind: 'ordinary' });
    expect(classifyCiRedReleasePr(null, pr())).toEqual({ kind: 'ordinary' });
    expect(classifyCiRedReleasePr({ ...config, enabled: false } as WorkspaceReleaseConfig, pr())).toEqual({ kind: 'ordinary' });
  });
});

describe('buildReleaseCandidateFixTask', () => {
  const built = buildReleaseCandidateFixTask({
    workspaceId: 'ws1',
    repoFullName: 'acme/app',
    prNumber: 76,
    headSha: 'cand-sha',
    version: '1.2.3',
    headRef: 'release/v1.2.3',
    sourceBranch: 'dev',
    failureContext: 'Integration: 4 tests failed',
    ciRunUrl: 'https://ci.example.test/run/1',
    ciFailedJobId: 9,
  });

  it('is based on the source branch, not the candidate branch, and binds to no PR', () => {
    expect(built.context.baseBranch).toBe('dev');
    expect(built.context.resumeBranch).toBeUndefined();
    expect(built.context.repairTarget).toBeUndefined();
    expect(built.context.prNumber).toBeUndefined();
    expect(built.context.releaseCandidateFix).toEqual({ prNumber: 76, headSha: 'cand-sha', version: '1.2.3', branch: 'release/v1.2.3', sourceBranch: 'dev' });
    expect('ciRetryPrNumber' in built).toBe(false);
    expect('parentTaskId' in built).toBe(false);
  });

  it('says never to push to the candidate, to open the PR into the source branch, and that an amendment follows', () => {
    expect(built.title).toContain('v1.2.3');
    expect(built.description).toContain('Do not push to `release/v1.2.3`');
    expect(built.description).toContain('into `dev`');
    expect(built.description).toContain('v1.2.3 (PR #76) needs an amendment or a re-cut once this merges');
    // Pipeline-neutral: no input names from buildd's own release workflow.
    expect(built.description).not.toContain('amend_confirm');
    expect(built.description).toContain('Integration: 4 tests failed');
    expect(built.description).toContain('/repos/acme/app/actions/jobs/9/logs');
    expect(built.description).not.toContain('--allow-escape-sequences');
  });

  it('the refusal text names the source branch and the amendment', () => {
    const t = releaseCandidateBranchPushRefusal(76, 'dev');
    expect(t).toContain('#76');
    expect(t).toContain('dev');
    expect(t).toContain('amend');
  });
});
