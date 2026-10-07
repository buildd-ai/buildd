import { describe, expect, test } from 'bun:test';
import { extractPrUrl, isCreatePrCall, detectCreatedPr, prRequiredUnmet } from '../../src/pr-detection';

// Exact success text produced by mcp-tools.ts create_pr handler.
const SUCCESS_RESULT =
  'Pull request created!\n\n**PR #42:** Add mission card\n**URL:** https://github.com/buildd-ai/buildd/pull/42\n**State:** open';

// What the agent saw on the real failure: create_pr ran but GitHub rejected it.
const FAILED_422_RESULT =
  'I attempted the required create_pr action. GitHub rejected it with 422: head invalid because the branch was never pushed.';

describe('extractPrUrl', () => {
  test('pulls a github PR URL out of the success text', () => {
    expect(extractPrUrl(SUCCESS_RESULT)).toBe('https://github.com/buildd-ai/buildd/pull/42');
  });

  test('returns null when no PR URL is present', () => {
    expect(extractPrUrl(FAILED_422_RESULT)).toBeNull();
    expect(extractPrUrl('')).toBeNull();
  });
});

describe('isCreatePrCall', () => {
  test('true for the direct create_pr tool', () => {
    expect(isCreatePrCall('create_pr', {})).toBe(true);
  });

  test('true for the buildd MCP tool with action=create_pr', () => {
    expect(isCreatePrCall('mcp__buildd__buildd', { action: 'create_pr' })).toBe(true);
  });

  test('false for other buildd actions and unrelated tools', () => {
    expect(isCreatePrCall('mcp__buildd__buildd', { action: 'complete_task' })).toBe(false);
    expect(isCreatePrCall('Bash', { command: 'git push' })).toBe(false);
    expect(isCreatePrCall(undefined, {})).toBe(false);
  });
});

describe('detectCreatedPr', () => {
  test('detects a real PR from a successful create_pr result', () => {
    const r = detectCreatedPr({
      toolName: 'mcp__buildd__buildd',
      input: { action: 'create_pr' },
      resultText: SUCCESS_RESULT,
    });
    expect(r.created).toBe(true);
    expect(r.url).toBe('https://github.com/buildd-ai/buildd/pull/42');
  });

  // Regression for the misleading 400: a create_pr that GitHub rejected (422)
  // must NOT satisfy the gate just because the tool ran.
  test('does NOT count a failed (422) create_pr as created', () => {
    const r = detectCreatedPr({
      toolName: 'mcp__buildd__buildd',
      input: { action: 'create_pr' },
      resultText: FAILED_422_RESULT,
    });
    expect(r.created).toBe(false);
    expect(r.url).toBeNull();
  });

  test('does NOT count an errored tool result as created', () => {
    const r = detectCreatedPr({
      toolName: 'mcp__buildd__buildd',
      input: { action: 'create_pr' },
      resultText: SUCCESS_RESULT, // even success-looking text is ignored when is_error
      isError: true,
    });
    expect(r.created).toBe(false);
  });

  test('ignores non-create_pr tool results', () => {
    const r = detectCreatedPr({
      toolName: 'Bash',
      input: { command: 'echo Pull request created! https://github.com/x/y/pull/1' },
      resultText: 'Pull request created! https://github.com/x/y/pull/1',
    });
    expect(r.created).toBe(false);
    expect(r.url).toBeNull();
  });
});

describe('prRequiredUnmet', () => {
  // The observed failure: pr_required, blocked environment, no PR, no commits.
  test('true when pr_required with no confirmed PR and no commits', () => {
    expect(prRequiredUnmet({ outputRequirement: 'pr_required', prCreated: false })).toBe(true);
  });

  // The mission's own motivating case: dozens of commits, still no confirmed
  // PR. Commit count must NOT gate this — session-end-classification.ts is
  // what decides what to do about the commits, not this check.
  test('true when pr_required with commits but still no confirmed PR', () => {
    expect(prRequiredUnmet({ outputRequirement: 'pr_required', prCreated: false })).toBe(true);
  });

  test('false when a PR was confirmed', () => {
    expect(prRequiredUnmet({ outputRequirement: 'pr_required', prCreated: true })).toBe(false);
  });

  test('only applies to pr_required', () => {
    expect(prRequiredUnmet({ outputRequirement: 'auto', prCreated: false })).toBe(false);
    expect(prRequiredUnmet({ outputRequirement: 'artifact_required', prCreated: false })).toBe(false);
    expect(prRequiredUnmet({ outputRequirement: undefined, prCreated: false })).toBe(false);
  });
});
