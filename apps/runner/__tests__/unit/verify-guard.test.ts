/**
 * The verify guard (verify-guard.ts): a whole-project test, typecheck or build
 * may not be capped below the time it needs, and a success may not be reported
 * while the last such command failed and no later run of its kind passed.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/verify-guard.test.ts
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  applyBashTimeoutEnv,
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  createVerifyGuardHook,
  shortVerifyTimeout,
  VERIFY_TIMEOUT_FLOOR_MS,
  wholeProjectVerify,
} from '../../src/verify-guard';
import { clearWorkerThrottle, scanBashResult, unrecoveredVerifyFailures } from '../../src/error-trace-scanner';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';
import type { LocalWorker } from '../../src/types';

const signal = { signal: new AbortController().signal };
const pre = (tool_name: string, tool_input: Record<string, unknown>) =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: '/wt' }) as any;
const reasonOf = (r: any): string | undefined =>
  r?.hookSpecificOutput?.permissionDecision === 'deny' ? r.hookSpecificOutput.permissionDecisionReason : undefined;

const failed = (code: number, text: string) => `Exit code ${code}\n${text}`;
const TIMED_OUT = 'Command timed out after 2m 0s';

describe('the agent env raises the Bash tool timeout to what a whole-project run needs', () => {
  test('default and maximum are set, and the default is at least the verify floor', () => {
    const env = applyBashTimeoutEnv({ PATH: '/bin' } as Record<string, string | undefined>);
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(BASH_DEFAULT_TIMEOUT_MS));
    expect(env.BASH_MAX_TIMEOUT_MS).toBe(String(BASH_MAX_TIMEOUT_MS));
    expect(BASH_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(VERIFY_TIMEOUT_FLOOR_MS);
    expect(BASH_MAX_TIMEOUT_MS).toBeGreaterThan(BASH_DEFAULT_TIMEOUT_MS);
    // The 2-minute default is what killed every example run; the floor must clear a 4-8 minute suite.
    expect(VERIFY_TIMEOUT_FLOOR_MS).toBeGreaterThanOrEqual(8 * 60_000);
  });

  test('an inherited value is overridden, not merged', () => {
    const env = applyBashTimeoutEnv({ BASH_DEFAULT_TIMEOUT_MS: '120000' } as Record<string, string | undefined>);
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(BASH_DEFAULT_TIMEOUT_MS));
  });
});

describe('wholeProjectVerify: which commands get the floor', () => {
  const WHOLE: Array<[string, string]> = [
    ['bun run test', 'test'],
    ['bun run test 2>&1 | tail -100', 'test'],
    ['npm test', 'test'],
    ['pnpm run test:unit', 'test'],
    ['bun test', 'test'],
    ['vitest run', 'test'],
    ['jest --ci', 'test'],
    ['bun run scripts/run-unit-tests.ts', 'test'],
    ['bun run type-check', 'typecheck'],
    ['bun run type-check 2>&1 | head -100', 'typecheck'],
    ['bunx tsc --noEmit', 'typecheck'],
    ['cd apps/web && bunx tsc --noEmit -p . 2>&1 | head -50', 'typecheck'],
    ['npx tsc --noEmit -p apps/web', 'typecheck'],
    ['bun run build:only', 'build'],
    ['cd apps/web && bun run build:only 2>&1 | tail -50', 'build'],
    ['next build', 'build'],
    ['timeout 120 bun run type-check 2>&1 | tail -40', 'typecheck'],
    ['sed -i "s/a/b/" x.ts && bun run scripts/run-unit-tests.ts x.test.ts | tail -4; bun run type-check 2>&1 | tail -4', 'typecheck'],
  ];
  for (const [command, family] of WHOLE) {
    test(`whole: ${command}`, () => {
      expect(wholeProjectVerify(command)?.family).toBe(family);
    });
  }

  const TARGETED = [
    'bun run scripts/run-unit-tests.ts apps/web/src/lib/foo.test.ts',
    'bun run scripts/run-unit-tests.ts apps/web/src/lib/foo.test.ts apps/web/src/lib/bar.test.ts 2>&1 | tail -20',
    'bun test apps/web/src/lib/foo.test.ts',
    'vitest run src/a.test.ts',
    'jest src/a.test.ts',
    'bunx tsc --noEmit apps/web/src/components/health/QueueRow.tsx',
    'bun run lint',
    'eslint src',
    'git status',
    'bun run scripts/check-specs.ts --check',
    'gh pr checks 5698',
    'echo "bun run test"',
  ];
  for (const command of TARGETED) {
    test(`not whole: ${command}`, () => {
      expect(wholeProjectVerify(command)).toBeNull();
    });
  }
});

describe('shortVerifyTimeout: a whole-project verify capped below the floor is refused', () => {
  test('a shell `timeout` wrapper below the floor', () => {
    const v = shortVerifyTimeout('timeout 120 bun run type-check 2>&1 | tail -40', undefined);
    expect(v).not.toBeNull();
    expect(v!.reason).toMatch(/type-?check/i);
    expect(v!.reason).toMatch(/2 ?min/i);
    expect(v!.hint).toMatch(/timeout/);
  });

  test('shell timeout forms: -k, --signal, minutes', () => {
    expect(shortVerifyTimeout('timeout -k 5 120 bun run test', undefined)).not.toBeNull();
    expect(shortVerifyTimeout('timeout --signal=TERM 300 bun run test', undefined)).not.toBeNull();
    expect(shortVerifyTimeout('timeout 2m bun run test', undefined)).not.toBeNull();
    expect(shortVerifyTimeout('timeout 15m bun run test', undefined)).toBeNull();
    expect(shortVerifyTimeout('timeout 900 bun run test', undefined)).toBeNull();
  });

  test('the Bash tool timeout parameter below the floor', () => {
    expect(shortVerifyTimeout('bun run test 2>&1 | tail -100', 120_000)).not.toBeNull();
    expect(shortVerifyTimeout('cd apps/web && bunx tsc --noEmit', 60_000)).not.toBeNull();
    expect(shortVerifyTimeout('bun run test', VERIFY_TIMEOUT_FLOOR_MS)).toBeNull();
    expect(shortVerifyTimeout('bun run test', 20 * 60_000)).toBeNull();
  });

  test('no explicit cap: the raised default applies, nothing to refuse', () => {
    expect(shortVerifyTimeout('bun run test', undefined)).toBeNull();
    expect(shortVerifyTimeout('bun run type-check', undefined)).toBeNull();
  });

  test('a targeted run may be capped as short as the agent likes', () => {
    expect(shortVerifyTimeout('timeout 120 bun run scripts/run-unit-tests.ts a.test.ts || true', undefined)).toBeNull();
    expect(shortVerifyTimeout('bun test apps/web/foo.test.ts', 30_000)).toBeNull();
    expect(shortVerifyTimeout('git status', 1_000)).toBeNull();
  });

  test('one short segment in a chain is enough', () => {
    expect(shortVerifyTimeout('bun run scripts/run-unit-tests.ts a.test.ts | tail -3; timeout 120 bun run type-check', undefined)).not.toBeNull();
  });
});

describe('unrecoveredVerifyFailures: what the runner knows at complete_task time', () => {
  beforeEach(() => clearWorkerThrottle('w-verify'));

  test('a killed typecheck is open until a typecheck passes', () => {
    scanBashResult('w-verify', { command: 'timeout 120 bun run type-check 2>&1 | tail -40', content: failed(143, TIMED_OUT), isError: true });
    const open = unrecoveredVerifyFailures('w-verify');
    expect(open).toHaveLength(1);
    expect(open[0].family).toBe('typecheck');
    expect(open[0].exitCode).toBe(143);
    expect(open[0].timedOut).toBe(true);
    expect(open[0].command).toContain('type-check');

    // A passing TEST run does not clear a TYPECHECK failure.
    scanBashResult('w-verify', { command: 'bun run scripts/run-unit-tests.ts a.test.ts', content: '1 pass', isError: false });
    expect(unrecoveredVerifyFailures('w-verify')).toHaveLength(1);

    scanBashResult('w-verify', { command: 'bun run type-check', content: 'ok', isError: false });
    expect(unrecoveredVerifyFailures('w-verify')).toHaveLength(0);
  });

  test('a repeat of the same failing command is still open (the trace dedupe does not hide it)', () => {
    const args = { command: 'bun run test', content: failed(1, '(fail) x'), isError: true };
    scanBashResult('w-verify', args);
    scanBashResult('w-verify', args);
    expect(unrecoveredVerifyFailures('w-verify')).toHaveLength(1);
    expect(unrecoveredVerifyFailures('w-verify')[0].timedOut).toBe(false);
  });

  test('the command is redacted before it is kept', () => {
    scanBashResult('w-verify', { command: 'TOKEN=sk-live-abc bun run test', content: failed(1, 'x'), isError: true }, (t) => t.replace('sk-live-abc', '[REDACTED]'));
    expect(unrecoveredVerifyFailures('w-verify')[0].command).toContain('[REDACTED]');
    expect(unrecoveredVerifyFailures('w-verify')[0].command).not.toContain('sk-live-abc');
  });

  test('a worker with no Bash history has nothing open', () => {
    expect(unrecoveredVerifyFailures('w-nobody')).toEqual([]);
  });
});

describe('the PreToolUse guard', () => {
  const worker = { id: 'w-guard', taskId: 't-guard' } as unknown as LocalWorker;
  beforeEach(() => clearWorkerThrottle('w-guard'));

  const buildd = (action: string, params: Record<string, unknown> = {}) =>
    pre('mcp__buildd__buildd', { action, params });

  test('refuses a short-capped whole-project verify with the runner marker and the fix', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    const reason = reasonOf(await hook(pre('Bash', { command: 'timeout 120 bun run test 2>&1 | tail -50' }), undefined, signal));
    expect(reason).toBeDefined();
    expect(reason).toContain(RUNNER_DENIAL_MARKER);
    expect(reason).toMatch(/exit 143/);
    expect(reason).toMatch(/complete_task/);
  });

  test('lets an uncapped or long-capped verify through, and every non-verify command', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    expect(reasonOf(await hook(pre('Bash', { command: 'bun run test' }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(pre('Bash', { command: 'bun run test', timeout: 600_000 }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(pre('Bash', { command: 'git status', timeout: 5_000 }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(pre('Read', { file_path: 'x' }), undefined, signal))).toBeUndefined();
  });

  test('refuses complete_task while the last typecheck was killed and never re-run', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    scanBashResult('w-guard', { command: 'timeout 120 bun run type-check', content: failed(143, TIMED_OUT), isError: true });
    const reason = reasonOf(await hook(buildd('complete_task', { summary: 'done, pushed' }), undefined, signal));
    expect(reason).toBeDefined();
    expect(reason).toContain(RUNNER_DENIAL_MARKER);
    expect(reason).toMatch(/typecheck/);
    expect(reason).toMatch(/143/);
    expect(reason).toMatch(/killed|timed out/i);
    expect(reason).toMatch(/complete_task/);
  });

  test('a real failure (exit 2) is named with its exit code, not as a timeout', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    scanBashResult('w-guard', { command: 'bunx tsc --noEmit', content: failed(2, 'error TS2307: Cannot find module'), isError: true });
    const reason = reasonOf(await hook(buildd('complete_task', { summary: 'done' }), undefined, signal));
    expect(reason).toMatch(/exited 2/);
    expect(reason).not.toMatch(/killed/i);
  });

  test('lets complete_task through once a run of the same kind passed', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    scanBashResult('w-guard', { command: 'bun run test', content: failed(143, TIMED_OUT), isError: true });
    scanBashResult('w-guard', { command: 'bun run test', content: 'all pass', isError: false });
    expect(reasonOf(await hook(buildd('complete_task', { summary: 'done' }), undefined, signal))).toBeUndefined();
  });

  test('never refuses a failure report, a wait, or a scratch completion', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    scanBashResult('w-guard', { command: 'bun run test', content: failed(1, '(fail) x'), isError: true });
    expect(reasonOf(await hook(buildd('complete_task', { error: 'suite is red on dev too' }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(buildd('complete_task', { blockedOnTaskId: 't-other', summary: 'needs it' }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(buildd('complete_task', { summary: 'scratch', discardEdits: 'conflict attempts' }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(buildd('update_progress', { message: 'x' }), undefined, signal))).toBeUndefined();
  });

  test('a reviewer may request changes on a red run, but may not approve on one', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: true });
    scanBashResult('w-guard', { command: 'bun run test', content: failed(1, '(fail) x'), isError: true });
    expect(reasonOf(await hook(buildd('complete_task', { summary: 'red', structuredOutput: { verdict: 'request-changes', confidence: 0.9, summary: 'red' } }), undefined, signal))).toBeUndefined();
    expect(reasonOf(await hook(buildd('complete_task', { summary: 'ok', structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'ok' } }), undefined, signal))).toBeDefined();
  });

  test('the group tool name is a buildd action tool too', async () => {
    const hook = createVerifyGuardHook({ worker, isReviewer: false });
    scanBashResult('w-guard', { command: 'bun run test', content: failed(1, '(fail) x'), isError: true });
    expect(reasonOf(await hook(pre('mcp__buildd__buildd_tasks', { action: 'complete_task', params: { summary: 'done' } }), undefined, signal))).toBeDefined();
  });
});
