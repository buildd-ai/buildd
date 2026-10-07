/**
 * S31 tier 2 (docs/specs/workflow-state-kernel.md §6.10): the runner runs the
 * workspace's configured preflight commands before a push or create_pr. A
 * failure denies that one call with the command's output as the agent's next
 * instruction, so the attempt stays open (WORKING/FIXING) instead of a red CI
 * run after the fact. Advisory: a command that cannot run lets the ship through.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/preflight-guard.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { createPreflightGuard, preflightCommands, preflightHookEntries, type PreflightRun } from '../../src/preflight-guard';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';

const BASH_PUSH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } };
const CREATE_PR = { hook_event_name: 'PreToolUse', tool_name: 'mcp__buildd__buildd', tool_input: { action: 'create_pr', params: { title: 't' } } };
const OTHER_BASH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'bun run test' } };

function harness(results: Record<string, PreflightRun>, head: () => string | null = () => 'H1') {
  const ran: string[] = [];
  const milestones: string[] = [];
  const guard = createPreflightGuard({
    commands: Object.keys(results),
    cwd: '/work',
    run: async (command) => { ran.push(command); return results[command]; },
    headSha: head,
    milestone: (label) => milestones.push(label),
  });
  return { guard, ran, milestones };
}

const ok: PreflightRun = { outcome: 'ok', exitCode: 0, output: '' };
const failed = (output: string): PreflightRun => ({ outcome: 'failed', exitCode: 1, output });

describe('preflightCommands', () => {
  test('reads gitConfig.preflight.commands, trimmed, empties dropped; absent → none', () => {
    expect(preflightCommands({ preflight: { commands: [' bun run no-prod-data:check ', '', 7 as never] } })).toEqual(['bun run no-prod-data:check']);
    expect(preflightCommands({ preflight: null })).toEqual([]);
    expect(preflightCommands(undefined)).toEqual([]);
  });
});

describe('createPreflightGuard', () => {
  test('a failing command denies the push with its output as the next instruction', async () => {
    const { guard, ran } = harness({ 'bun run no-prod-data:check': failed('::error::PR body: possible UUID at line 3') });
    const res = await guard(BASH_PUSH) as any;
    expect(ran).toEqual(['bun run no-prod-data:check']);
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason: string = res.hookSpecificOutput.permissionDecisionReason;
    expect(reason.startsWith(RUNNER_DENIAL_MARKER)).toBe(true);
    expect(reason).toContain('bun run no-prod-data:check');
    expect(reason).toContain('possible UUID at line 3');
  });

  test('create_pr is gated the same way', async () => {
    const { guard } = harness({ 'lint': failed('2 problems') });
    expect(((await guard(CREATE_PR)) as any).hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('every command passing lets the ship through, and the same head is not re-checked', async () => {
    const { guard, ran } = harness({ a: ok, b: ok });
    expect(await guard(BASH_PUSH)).toEqual({});
    expect(await guard(CREATE_PR)).toEqual({});
    expect(ran).toEqual(['a', 'b']);
  });

  test('a new head is checked again', async () => {
    let head = 'H1';
    const { guard, ran } = harness({ a: ok }, () => head);
    await guard(BASH_PUSH);
    head = 'H2';
    await guard(BASH_PUSH);
    expect(ran).toEqual(['a', 'a']);
  });

  test('advisory: a command that cannot run or times out lets the ship through, and says so', async () => {
    const { guard, milestones } = harness({ missing: { outcome: 'exec_error', exitCode: null, output: 'not found' }, slow: { outcome: 'timeout', exitCode: null, output: '' } });
    expect(await guard(BASH_PUSH)).toEqual({});
    expect(milestones.some((m) => m.includes('missing') && m.includes('could not run'))).toBe(true);
  });

  test('non-ship calls and other hook events are untouched', async () => {
    const { guard, ran } = harness({ a: failed('x') });
    expect(await guard(OTHER_BASH)).toEqual({});
    expect(await guard({ ...BASH_PUSH, hook_event_name: 'PostToolUse' })).toEqual({});
    expect(await guard({ ...CREATE_PR, tool_input: { action: 'complete_task' } })).toEqual({});
    expect(ran).toEqual([]);
  });

  test('the output in the denial is a bounded tail', async () => {
    const { guard } = harness({ a: failed('x'.repeat(10_000) + 'THE END') });
    const reason: string = ((await guard(BASH_PUSH)) as any).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('THE END');
    expect(reason.length).toBeLessThan(3_000);
  });
});

describe('preflightHookEntries (what the session registers)', () => {
  test('one PreToolUse entry when the workspace lists commands, with a timeout covering them all', () => {
    const entries = preflightHookEntries({ gitConfig: { preflight: { commands: ['a', 'b'] } }, isCodexTask: false, cwd: '/w' });
    expect(entries.length).toBe(1);
    expect(entries[0].hooks.length).toBe(1);
    expect(entries[0].timeout).toBeGreaterThan(240);
  });
  test('none by default, and none for Codex', () => {
    expect(preflightHookEntries({ gitConfig: undefined, isCodexTask: false, cwd: '/w' })).toEqual([]);
    expect(preflightHookEntries({ gitConfig: { preflight: { commands: ['a'] } }, isCodexTask: true, cwd: '/w' })).toEqual([]);
  });
});
