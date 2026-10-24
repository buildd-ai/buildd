import { describe, it, expect } from 'bun:test';
import { isLivingSpecRevisionTask } from './spec-revision-task';

describe('isLivingSpecRevisionTask', () => {
  it('matches a manage_specs revise task', () => {
    expect(isLivingSpecRevisionTask({ title: 'Write spec', description: 'Use manage_specs action=revise to add AC-3' })).toBe(true);
  });
  it('matches a Living Spec revision', () => {
    expect(isLivingSpecRevisionTask({ title: 'Revise the Living Spec for billing' })).toBe(true);
  });
  it('leaves a repo contract file edit alone', () => {
    expect(isLivingSpecRevisionTask({ title: 'docs: update docs/specs/billing.md', description: 'edit the file' })).toBe(false);
  });
  it('handles empty input', () => {
    expect(isLivingSpecRevisionTask({})).toBe(false);
  });
});
