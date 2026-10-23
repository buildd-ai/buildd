import { describe, expect, it } from 'bun:test';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { buildReleaseConfigPayload, type ReleaseFormState } from './release-config-payload';

const form = (o: Partial<ReleaseFormState> = {}): ReleaseFormState => ({
  strategy: 'workflow_dispatch', prodBranch: 'main', ref: 'dev', workflowFile: 'release.yml', trigger: 'on_mission_complete',
  candidateEnabled: false, candidateBranches: '', candidateSource: '', candidateAuthors: '',
  candidateAmendMode: 'none', candidateAmendVersionInput: '', candidateAmendConfirmInput: '', ...o,
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

  it('saves the amend mapping exactly as typed, and none when none is chosen', () => {
    const on = { candidateEnabled: true, candidateBranches: 'release/v*', candidateSource: 'dev', candidateAuthors: 'github-actions[bot]' };
    expect((buildReleaseConfigPayload(loaded, form({ ...on, candidateAmendMode: 'inputs', candidateAmendVersionInput: ' amend ', candidateAmendConfirmInput: 'amend_confirm' })).candidate as any).amend)
      .toEqual({ mode: 'inputs', versionInput: 'amend', confirmInput: 'amend_confirm' });
    expect((buildReleaseConfigPayload(loaded, form({ ...on, candidateAmendMode: 'inputs', candidateAmendVersionInput: 'v' })).candidate as any).amend)
      .toEqual({ mode: 'inputs', versionInput: 'v' });
    expect((buildReleaseConfigPayload(loaded, form({ ...on, candidateAmendMode: 'redispatch' })).candidate as any).amend).toEqual({ mode: 'redispatch' });
    expect((buildReleaseConfigPayload(loaded, form({ ...on, candidateAmendMode: 'none', candidateAmendVersionInput: 'amend' })).candidate as any).amend).toBeUndefined();
    // Only a workflow can be dispatched.
    expect((buildReleaseConfigPayload(loaded, form({ ...on, strategy: 'branch_merge', candidateAmendMode: 'redispatch' })).candidate as any).amend).toBeUndefined();
  });

  it('turning candidates off removes the policy', () => {
    const withCandidate = { ...loaded, candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] } };
    expect(buildReleaseConfigPayload(withCandidate, form()).candidate).toBeUndefined();
  });

  it("'none' disables releases", () => {
    expect(buildReleaseConfigPayload(loaded, form({ strategy: 'none' }))).toEqual({ strategy: 'none' });
  });
});
