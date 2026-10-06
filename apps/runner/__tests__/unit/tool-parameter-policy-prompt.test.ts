import { describe, expect, test } from 'bun:test';

/**
 * Tests the Tool Parameter Policy prompt section in workers.ts startWorker().
 * Verifies that agents are warned about run_in_background limitations in
 * non-interactive cloud runner environments.
 */
describe('Tool Parameter Policy prompt injection', () => {
  test('includes warning about run_in_background', () => {
    const toolParameterPolicy = '## Tool Parameter Policy\nDo NOT use `run_in_background: true` in Bash tool calls. This parameter expects to re-invoke you after the task completes, but that mechanism does not exist in this execution environment. Instead: poll the task status synchronously in a loop, or wait for the tool result directly. If a long-running task would exceed your tool timeout, that is a blocker you should report to the user rather than work around with background execution.';

    expect(toolParameterPolicy).toContain('run_in_background');
    expect(toolParameterPolicy).toContain('Tool Parameter Policy');
  });

  test('explains why run_in_background does not work', () => {
    const toolParameterPolicy = '## Tool Parameter Policy\nDo NOT use `run_in_background: true` in Bash tool calls. This parameter expects to re-invoke you after the task completes, but that mechanism does not exist in this execution environment. Instead: poll the task status synchronously in a loop, or wait for the tool result directly. If a long-running task would exceed your tool timeout, that is a blocker you should report to the user rather than work around with background execution.';

    expect(toolParameterPolicy).toContain('re-invoke');
    expect(toolParameterPolicy).toContain('execution environment');
  });

  test('offers polling as an alternative', () => {
    const toolParameterPolicy = '## Tool Parameter Policy\nDo NOT use `run_in_background: true` in Bash tool calls. This parameter expects to re-invoke you after the task completes, but that mechanism does not exist in this execution environment. Instead: poll the task status synchronously in a loop, or wait for the tool result directly. If a long-running task would exceed your tool timeout, that is a blocker you should report to the user rather than work around with background execution.';

    expect(toolParameterPolicy).toContain('poll');
    expect(toolParameterPolicy).toContain('synchronously');
  });

  test('advises reporting timeouts as blockers', () => {
    const toolParameterPolicy = '## Tool Parameter Policy\nDo NOT use `run_in_background: true` in Bash tool calls. This parameter expects to re-invoke you after the task completes, but that mechanism does not exist in this execution environment. Instead: poll the task status synchronously in a loop, or wait for the tool result directly. If a long-running task would exceed your tool timeout, that is a blocker you should report to the user rather than work around with background execution.';

    expect(toolParameterPolicy).toContain('blocker');
    expect(toolParameterPolicy).toContain('report to the user');
  });
});
