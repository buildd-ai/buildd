import { describe, expect, it } from 'bun:test';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { buildReleaseConfigPayload, type ReleaseFormState } from './release-config-payload';

const form = (o: Partial<ReleaseFormState> = {}): ReleaseFormState => ({
  strategy: 'workflow_dispatch', prodBranch: 'main', ref: 'dev', workflowFile: 'release.yml', trigger: 'on_mission_complete',
  candidateEnabled: false, candidateBranches: '', candidateSource: '', candidateAuthors: '', ...o,
});

const loaded: WorkspaceReleaseConfig = {
  enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main',
  inputs: { force: 'false' }, verificationUrl: 'https://example.test/health', deployTarget: { type: 'vercel', projectId: 'p' },
};

describe('buildReleaseConfigPayload', () => {
  it('keeps prodBranch and every field the form does not edit on a workflow_dispatch save', () => {
    const p = buildReleaseConfigPayload(loaded, form());
    expect(p).toMatchObject({
      enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main',
      inputs: { force: 'false' }, verificationUrl: 'https://example.test/health', deployTarget: { type: 'vercel', projectId: 'p' },
    });
    expect(p.candidate).toBeUndefined();
  });

  it('saves exactly the candidate policy typed, split on commas', () => {
    const p = buildReleaseConfigPayload(loaded, form({
      candidateEnabled: true, candidateBranches: 'release/v*, release/next', candidateSource: ' dev ', candidateAuthors: 'github-actions[bot]',
    }));
    expect(p.candidate).toEqual({ branches: ['release/v*', 'release/next'], sourceBranch: 'dev', authors: ['github-actions[bot]'] });
    // The dispatcher ref is untouched by the candidate source.
    expect(p.ref).toBe('dev');
  });

  it('turning candidates off removes the policy', () => {
    const withCandidate = { ...loaded, candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] } };
    expect(buildReleaseConfigPayload(withCandidate, form()).candidate).toBeUndefined();
  });

  it("'none' disables releases", () => {
    expect(buildReleaseConfigPayload(loaded, form({ strategy: 'none' }))).toEqual({ strategy: 'none' });
  });
});
