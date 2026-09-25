import { describe, expect, test } from 'bun:test';
import { outputRequirementNudge } from '../../src/output-requirement-nudge';

const buildd = (action: string) => ({ name: 'mcp__buildd__buildd', input: { action } });

describe('outputRequirementNudge', () => {
  test('artifact_required with nothing delivered nudges', () => {
    expect(outputRequirementNudge({ outputRequirement: 'artifact_required', roleSlug: null, hasPR: false, toolCalls: [] }))
      .toContain('requires a deliverable');
  });

  test('create_artifact satisfies artifact_required', () => {
    expect(outputRequirementNudge({ outputRequirement: 'artifact_required', roleSlug: null, hasPR: false, toolCalls: [buildd('create_artifact')] }))
      .toBeNull();
  });

  test('upload_artifact satisfies artifact_required', () => {
    expect(outputRequirementNudge({ outputRequirement: 'artifact_required', roleSlug: null, hasPR: false, toolCalls: [buildd('upload_artifact')] }))
      .toBeNull();
  });

  test('pr_required still needs a PR', () => {
    expect(outputRequirementNudge({ outputRequirement: 'pr_required', roleSlug: null, hasPR: false, toolCalls: [buildd('create_artifact')] }))
      .toContain('requires a pull request');
    expect(outputRequirementNudge({ outputRequirement: 'pr_required', roleSlug: null, hasPR: true, toolCalls: [] })).toBeNull();
  });

  test('auto / none never nudge', () => {
    expect(outputRequirementNudge({ outputRequirement: 'auto', roleSlug: null, hasPR: false, toolCalls: [] })).toBeNull();
    expect(outputRequirementNudge({ outputRequirement: undefined, roleSlug: null, hasPR: false, toolCalls: [] })).toBeNull();
  });

  test('a visual-auditor task is never told to open a PR, even with nothing uploaded', () => {
    // Its audit is artifact_required; the boot-failure path ends with no uploads.
    expect(outputRequirementNudge({ outputRequirement: 'artifact_required', roleSlug: 'visual-auditor', hasPR: false, toolCalls: [] }))
      .toBeNull();
    expect(outputRequirementNudge({ outputRequirement: 'pr_required', roleSlug: 'visual-auditor', hasPR: false, toolCalls: [] }))
      .toBeNull();
  });
});
