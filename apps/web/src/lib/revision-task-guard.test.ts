import { describe, it, expect } from 'bun:test';
import { isLivingSpecRevisionTask } from './revision-task-guard';

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
  it('matches a task that drafts a new Living Spec (create_draft is refused to builders too)', () => {
    expect(isLivingSpecRevisionTask({ title: 'Draft Living Spec and plan artifact: skill candidates' })).toBe(true);
    expect(isLivingSpecRevisionTask({ title: 'manage_specs create_draft: checkout totals' })).toBe(true);
    expect(isLivingSpecRevisionTask({ title: 'Write a Living Spec for billing' })).toBe(true);
    expect(isLivingSpecRevisionTask({ title: 'Create a new Living Spec for exports' })).toBe(true);
  });
  it('leaves a task that builds against a Living Spec alone', () => {
    expect(isLivingSpecRevisionTask({ title: 'feat: checkout totals', description: 'Builds Living Spec 1b257609, R-1 to R-4. Built ahead of approval if it is still a draft.' })).toBe(false);
    expect(isLivingSpecRevisionTask({ title: 'Implement the Living Spec drafted by the previous task' })).toBe(false);
    expect(isLivingSpecRevisionTask({ title: 'feat: checkout totals', description: 'Depends on the task that drafts the Living Spec with manage_specs create_draft; build what it wrote.' })).toBe(false);
  });
});

