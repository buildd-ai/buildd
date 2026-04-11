import { describe, expect, test } from 'bun:test';

/**
 * Tests the output requirement prompt injection logic from workers.ts startWorker().
 * Mirrors the inline logic to verify the correct prompt section is generated
 * for each outputRequirement value.
 */
function buildOutputRequirementPrompt(
  outputRequirement: string | undefined,
  mode?: string
): string | null {
  const outputReq = outputRequirement || 'auto';
  if (mode === 'planning') {
    return '## Output Requirement\nThis is a **planning task**. Produce a structured plan — do not make code changes.';
  } else if (outputReq === 'pr_required') {
    return '## Output Requirement\nThis task **requires a PR**. Make your changes, commit, push, and create a PR via `buildd` action: create_pr before completing.';
  } else if (outputReq === 'artifact_required') {
    return '## Output Requirement\nThis task **requires you to create an artifact** as a deliverable. Use `buildd` action: create_artifact before completing the task.';
  } else if (outputReq === 'none') {
    return '## Output Requirement\nThis task has **no output requirement**. Complete with a summary — no commits, PRs, or artifacts needed unless the work calls for it.';
  }
  // 'auto' — no explicit section
  return null;
}

/**
 * Mirrors the in-loop output requirement gate from workers.ts.
 * Returns a nudge message if the requirement is unmet, null otherwise.
 */
function checkOutputRequirement(
  outputRequirement: string | undefined,
  hasPR: boolean,
  hasArtifact: boolean,
  nudgeCount: number,
  maxNudges: number,
): string | null {
  const outputReq = outputRequirement || 'auto';
  if (nudgeCount >= maxNudges) return null;
  if (outputReq !== 'pr_required' && outputReq !== 'artifact_required') return null;

  const unmet = outputReq === 'pr_required' ? !hasPR : !hasPR && !hasArtifact;
  if (!unmet) return null;

  return outputReq === 'pr_required'
    ? 'You are not done yet — this task requires a pull request. Create one using `buildd` action: create_pr, then call complete_task.'
    : 'You are not done yet — this task requires a deliverable. Create a PR (create_pr) or artifact (create_artifact), then call complete_task.';
}

describe('Output requirement prompt injection', () => {
  test('pr_required tells agent to create a PR before completing', () => {
    const result = buildOutputRequirementPrompt('pr_required');
    expect(result).toContain('requires a PR');
    expect(result).toContain('create_pr');
  });

  test('artifact_required tells agent to create an artifact', () => {
    const result = buildOutputRequirementPrompt('artifact_required');
    expect(result).toContain('requires you to create an artifact');
    expect(result).toContain('create_artifact');
  });

  test('none tells agent no deliverables needed', () => {
    const result = buildOutputRequirementPrompt('none');
    expect(result).toContain('no output requirement');
  });

  test('auto produces no explicit section', () => {
    const result = buildOutputRequirementPrompt('auto');
    expect(result).toBeNull();
  });

  test('undefined defaults to auto (no section)', () => {
    const result = buildOutputRequirementPrompt(undefined);
    expect(result).toBeNull();
  });

  test('planning mode overrides outputRequirement', () => {
    const result = buildOutputRequirementPrompt('pr_required', 'planning');
    expect(result).toContain('planning task');
    expect(result).not.toContain('requires a PR');
  });
});

describe('Output requirement in-loop gate', () => {
  test('nudges when pr_required and no PR created', () => {
    const nudge = checkOutputRequirement('pr_required', false, false, 0, 2);
    expect(nudge).toContain('requires a pull request');
    expect(nudge).toContain('create_pr');
  });

  test('passes when pr_required and PR exists', () => {
    const nudge = checkOutputRequirement('pr_required', true, false, 0, 2);
    expect(nudge).toBeNull();
  });

  test('nudges when artifact_required and no PR or artifact', () => {
    const nudge = checkOutputRequirement('artifact_required', false, false, 0, 2);
    expect(nudge).toContain('requires a deliverable');
    expect(nudge).toContain('create_artifact');
  });

  test('passes when artifact_required and PR exists', () => {
    const nudge = checkOutputRequirement('artifact_required', true, false, 0, 2);
    expect(nudge).toBeNull();
  });

  test('passes when artifact_required and artifact exists', () => {
    const nudge = checkOutputRequirement('artifact_required', false, true, 0, 2);
    expect(nudge).toBeNull();
  });

  test('stops nudging after max attempts', () => {
    const nudge = checkOutputRequirement('pr_required', false, false, 2, 2);
    expect(nudge).toBeNull();
  });

  test('ignores auto requirement', () => {
    const nudge = checkOutputRequirement('auto', false, false, 0, 2);
    expect(nudge).toBeNull();
  });

  test('ignores none requirement', () => {
    const nudge = checkOutputRequirement('none', false, false, 0, 2);
    expect(nudge).toBeNull();
  });
});
