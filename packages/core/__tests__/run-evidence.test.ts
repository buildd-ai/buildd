import { describe, expect, test } from 'bun:test';
import { deriveRunEvidence, type RunEvidenceInput } from '../run-evidence';
const phase = (input: RunEvidenceInput, key: string) => deriveRunEvidence(input).phases.find(p => p.key === key)!;
const checkpoint = (event: string) => ({ milestones: [{ type: 'checkpoint', event, ts: 20 }] });
describe('observed run evidence', () => {
  test('missing facts remain unknown, except the existing worker is claimed', () => {
    const phases = deriveRunEvidence({}).phases;
    expect(phases[0]).toMatchObject({ key: 'claimed', state: 'done', source: 'observed', at: null });
    expect(phases.slice(1).every(p => p.state === 'unknown')).toBe(true);
  });
  for (const [key, input] of [
    ['claimed', { createdAt: 10 }], ['started', checkpoint('session_started')],
    ['started', { startedAt: 10 }], ['changed', checkpoint('first_edit')],
    ['changed', { dirtyWorktree: true }], ['changed', { observedTouches: ['src/a.ts'] }],
    ['committed', { lastCommitSha: 'head', commitCount: 1 }], ['pushed', checkpoint('first_push')],
    ['pr_open', { prNumber: 1 }], ['merged', { mergedAt: 20 }], ['merged', { prLifecycleStatus: 'merged' }],
    ['delivered', { outputRequirement: 'artifact_required', deliverableArtifactCount: 1 }],
    ['delivered', { outputRequirement: 'none', status: 'completed' }],
  ] as [string, RunEvidenceInput][]) test(`${key} requires its fact: ${JSON.stringify(input)}`, () => {
    expect(phase(input, key)).toMatchObject({ state: 'done', source: 'observed' });
  });
  test('MCP file counts are reported; legacy commit checkpoints inferred', () => {
    expect(phase({ filesChanged: 2 }, 'changed').source).toBe('reported');
    expect(phase(checkpoint('first_commit'), 'committed').source).toBe('inferred');
    expect(phase({ ...checkpoint('first_commit'), commitCount: 1, lastCommitSha: 'head' }, 'committed').source).toBe('observed');
  });
  test('PR implies push, never commit or changes', () => {
    expect(phase({ prUrl: 'https://example.test/pr/1' }, 'pushed')).toMatchObject({ state: 'done', source: 'implied' });
    expect(phase({ prNumber: 1 }, 'committed').state).toBe('unknown');
    expect(phase({ prNumber: 1, prIsDraft: true }, 'pr_open').label).toBe('Draft PR');
  });
  for (const [status, state, subState] of [['ci_running', 'current', 'running'], ['ci_green', 'done', 'passed'], ['ci_failed', 'failed', 'failed'], ['conflict', 'failed', 'conflict']]) test(`CI ${status}`, () => {
    expect(phase({ status: 'running', prLifecycleStatus: status }, 'ci')).toMatchObject({ state, subState, source: 'observed' });
  });
  for (const reviewState of ['queued', 'reviewing', 'approved', 'changes_requested', 'escalated', 'review_failed']) test(`review ${reviewState}`, () => {
    const p = phase({ reviewState, status: 'running' }, 'review');
    expect(p.source).toBe('observed');
    expect(p.subState).toBe(reviewState);
    expect(p.state).toBe(['changes_requested','escalated','review_failed'].includes(reviewState) ? 'failed' : reviewState === 'approved' ? 'done' : 'current');
  });
  test('closed unmerged PR is failed; merge wins over closed', () => {
    expect(phase({ prNumber: 1, prLifecycleStatus: 'closed' }, 'pr_open').state).toBe('failed');
    expect(phase({ prNumber: 1, prLifecycleStatus: 'closed', mergedAt: 20 }, 'pr_open').state).toBe('done');
  });
  test('artifact path omits irrelevant phases and absent changes', () => {
    expect(deriveRunEvidence({ outputRequirement: 'artifact_required' }).phases.map(p => p.key)).toEqual(['claimed', 'started', 'delivered']);
    expect(deriveRunEvidence({ outputRequirement: 'none', dirtyWorktree: true }).phases.map(p => p.key)).toEqual(['claimed','started','changed','delivered']);
  });
  test('review policy skips reviewer only when known unused', () => {
    expect(phase({ usesReviewer: false }, 'review').state).toBe('skipped');
    expect(phase({ usesReviewer: false, reviewState: 'queued' }, 'review').state).not.toBe('skipped');
  });
  test('first observation time is retained; narration is never evidence', () => {
    expect(phase({ milestones: [{ type:'checkpoint', event:'first_edit', ts:30 }, { type:'checkpoint', event:'first_edit', ts:20 }] }, 'changed').at).toBe(20);
    expect(phase({ milestones: [{ type:'status', label:'Commit: something', progress:90, ts:20 }] }, 'committed').state).toBe('unknown');
    expect(phase({ commitCount: 1 }, 'committed').state).toBe('unknown');
  });
});
