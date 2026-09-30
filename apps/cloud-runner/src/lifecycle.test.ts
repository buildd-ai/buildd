import { describe, expect, test } from 'bun:test';
import * as runOnce from '../../runner/src/run-once';
import {
  ANTHROPIC_API_KEY_PLACEHOLDER,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  EXIT_CLAIM_REFUSED,
  EXIT_COMPLETED,
  EXIT_FAILED,
  EXIT_USAGE,
  INITIAL_STATE,
  WORKER_ID_LINE_PREFIX,
  appendTail,
  buildContainerEnv,
  crashReportAction,
  decideDispatch,
  isOrphanedRun,
  isValidTaskId,
  outcomeForExitCode,
  parseWorkerIdLine,
  resolveInactivityTimeoutMs,
  runnerCommand,
  type RunState,
} from './lifecycle';

describe('exit code contract with run-once.ts', () => {
  test('codes and the worker-id prefix match the runner', () => {
    expect(EXIT_COMPLETED).toBe(runOnce.EXIT_COMPLETED);
    expect(EXIT_FAILED).toBe(runOnce.EXIT_FAILED);
    expect(EXIT_CLAIM_REFUSED).toBe(runOnce.EXIT_CLAIM_REFUSED);
    expect(EXIT_USAGE).toBe(runOnce.EXIT_USAGE);
    expect(WORKER_ID_LINE_PREFIX).toBe(runOnce.WORKER_ID_LINE_PREFIX);
  });
});

describe('outcomeForExitCode', () => {
  test.each([
    [0, 'done'],
    [1, 'failed'],
    [3, 'refused'],
    [64, 'usage'],
    [137, 'crashed'], // SIGKILL / OOM
    [143, 'crashed'], // SIGTERM
    [2, 'crashed'],
    [75, 'crashed'], // the launcher restart code is never a --once result
    [-1, 'crashed'],
  ] as const)('%p -> %p', (code, outcome) => {
    expect(outcomeForExitCode(code)).toBe(outcome);
  });

  test('no exit code at all is a crash', () => {
    expect(outcomeForExitCode(null)).toBe('crashed');
    expect(outcomeForExitCode(undefined)).toBe('crashed');
  });
});

describe('decideDispatch', () => {
  const at = (status: RunState['status'], attempt: number): RunState => ({ ...INITIAL_STATE, taskId: 't', status, attempt });

  test('a fresh agent starts attempt 1', () => {
    expect(decideDispatch(INITIAL_STATE)).toEqual({ action: 'start', attempt: 1 });
  });

  test('a duplicate while starting or running is ignored', () => {
    expect(decideDispatch(at('starting', 1))).toEqual({ action: 'ignore', reason: 'already_live' });
    expect(decideDispatch(at('running', 2))).toEqual({ action: 'ignore', reason: 'already_live' });
  });

  test('a dispatch after an exit starts the next attempt', () => {
    expect(decideDispatch(at('exited', 1))).toEqual({ action: 'start', attempt: 2 });
    expect(decideDispatch(at('exited', 4))).toEqual({ action: 'start', attempt: 5 });
  });
});

describe('crashReportAction', () => {
  test('only a crash with a known worker is reported', () => {
    expect(crashReportAction('crashed', 'w-1')).toBe('report');
    expect(crashReportAction('crashed', undefined)).toBe('skip_no_worker');
    for (const o of ['done', 'failed', 'refused', 'usage'] as const) {
      expect(crashReportAction(o, 'w-1')).toBe('none');
    }
  });
});

describe('isOrphanedRun', () => {
  test('a live status with no run in memory is orphaned', () => {
    expect(isOrphanedRun({ ...INITIAL_STATE, status: 'running', attempt: 1 }, false)).toBe(true);
    expect(isOrphanedRun({ ...INITIAL_STATE, status: 'starting', attempt: 1 }, false)).toBe(true);
    expect(isOrphanedRun({ ...INITIAL_STATE, status: 'running', attempt: 1 }, true)).toBe(false);
    expect(isOrphanedRun({ ...INITIAL_STATE, status: 'exited', attempt: 1 }, false)).toBe(false);
    expect(isOrphanedRun(INITIAL_STATE, false)).toBe(false);
  });
});

describe('parseWorkerIdLine', () => {
  test('reads the id', () => {
    expect(parseWorkerIdLine('BUILDD_WORKER_ID=0f1e2d3c-aaaa-bbbb-cccc-000011112222')).toBe('0f1e2d3c-aaaa-bbbb-cccc-000011112222');
    expect(parseWorkerIdLine('  BUILDD_WORKER_ID=w-1  ')).toBe('w-1');
  });

  test('ignores other lines and unsafe ids', () => {
    expect(parseWorkerIdLine('[once] worker w-1 started')).toBeNull();
    expect(parseWorkerIdLine('BUILDD_WORKER_ID=')).toBeNull();
    expect(parseWorkerIdLine('BUILDD_WORKER_ID=../../x')).toBeNull();
    expect(parseWorkerIdLine('x BUILDD_WORKER_ID=w-1')).toBeNull();
  });
});

describe('isValidTaskId', () => {
  test('accepts uuids and short tokens', () => {
    expect(isValidTaskId('0f1e2d3c-aaaa-bbbb-cccc-000011112222')).toBe(true);
    expect(isValidTaskId('smoke-123')).toBe(true);
  });

  test('rejects non-strings, flags, paths and long values', () => {
    for (const v of [undefined, null, 42, {}, '', '-x', '--task', 'a/b', 'a b', 'a;b', 'x'.repeat(129)]) {
      expect(isValidTaskId(v)).toBe(false);
    }
  });
});

describe('container env', () => {
  test('minimal env with a placeholder model key and no GitHub token', () => {
    const env = buildContainerEnv({ BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_API_KEY: 'bld_test' });
    expect(env).toEqual({
      BUILDD_SERVER: 'http://127.0.0.1:9',
      BUILDD_API_KEY: 'bld_test',
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY_PLACEHOLDER,
      BUILDD_DISABLE_AUTO_UPDATE: '1',
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('passes optional settings through only when set', () => {
    const env = buildContainerEnv({
      BUILDD_SERVER: 's', BUILDD_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic', MODEL: '', PUSHER_KEY: 'pk',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example/anthropic');
    expect(env.PUSHER_KEY).toBe('pk');
    expect('MODEL' in env).toBe(false);
  });

  test('refuses to build without a server or key (the runner would default to production)', () => {
    expect(() => buildContainerEnv({ BUILDD_API_KEY: 'k' })).toThrow(/BUILDD_SERVER/);
    expect(() => buildContainerEnv({ BUILDD_SERVER: 's' })).toThrow(/BUILDD_API_KEY/);
  });

  // Local end-to-end only (scripts/local-e2e.sh): a real model key for a
  // container talking to a buildd on this machine. On Cloudflare the key is
  // added at egress, so a real key in the env anywhere else is a mistake.
  test('DEV_ANTHROPIC_API_KEY replaces the placeholder for a local buildd', () => {
    for (const server of ['http://host.docker.internal:3217', 'http://localhost:3000', 'http://127.0.0.1:9']) {
      const env = buildContainerEnv({ BUILDD_SERVER: server, BUILDD_API_KEY: 'k', DEV_ANTHROPIC_API_KEY: 'sk-ant-dev' });
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-dev');
    }
  });

  test('DEV_ANTHROPIC_API_KEY is refused for any other buildd', () => {
    for (const server of ['https://buildd.dev', 'https://localhost.example.com', 'http://host.docker.internal.evil.example']) {
      expect(() => buildContainerEnv({ BUILDD_SERVER: server, BUILDD_API_KEY: 'k', DEV_ANTHROPIC_API_KEY: 'sk-ant-dev' }))
        .toThrow(/local testing only/);
    }
  });

  test('an empty DEV_ANTHROPIC_API_KEY keeps the placeholder', () => {
    const env = buildContainerEnv({ BUILDD_SERVER: 'https://buildd.dev', BUILDD_API_KEY: 'k', DEV_ANTHROPIC_API_KEY: '' });
    expect(env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_API_KEY_PLACEHOLDER);
  });

  test('command runs the image helper for exactly this task', () => {
    expect(runnerCommand('t-1')).toEqual(['buildd-once', '--task', 't-1']);
  });
});

describe('config', () => {
  test('inactivity timeout defaults to 30 minutes and accepts overrides', () => {
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(resolveInactivityTimeoutMs({})).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs({ CONTAINER_INACTIVITY_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(resolveInactivityTimeoutMs({ CONTAINER_INACTIVITY_TIMEOUT_MS: 'nope' })).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs({ CONTAINER_INACTIVITY_TIMEOUT_MS: '0' })).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
  });

  test('output tail is bounded', () => {
    let tail: string[] = [];
    for (let i = 0; i < 50; i++) tail = appendTail(tail, `line ${i}`, 5);
    expect(tail).toEqual(['line 45', 'line 46', 'line 47', 'line 48', 'line 49']);
    expect(appendTail([], 'x'.repeat(1000))[0]!.length).toBeLessThan(500);
  });
});
