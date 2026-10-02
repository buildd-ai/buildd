import { describe, expect, test } from 'bun:test';
import * as runOnce from '../../runner/src/run-once';
import {
  ANTHROPIC_API_KEY_PLACEHOLDER,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  EXIT_CLAIM_REFUSED,
  EXIT_COMPLETED,
  EXIT_FAILED,
  EXIT_PARKED,
  EXIT_USAGE,
  PARKED_LINE_PREFIX,
  resumableRunsEnabled,
  parseParkedLine,
  orphanParkCommand,
  INITIAL_STATE,
  WORKER_ID_LINE_PREFIX,
  appendTail,
  buildContainerEnv,
  IMAGE_ENV,
  warmReposEnabled,
  crashReportAction,
  parseTaskTokenResponse,
  taskTokenRequest,
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
    expect(EXIT_PARKED).toBe(runOnce.EXIT_PARKED);
    expect(EXIT_PARKED).toBe(4);
    expect(WORKER_ID_LINE_PREFIX).toBe(runOnce.WORKER_ID_LINE_PREFIX);
    expect(PARKED_LINE_PREFIX).toBe(runOnce.PARKED_LINE_PREFIX);
  });
});

describe('outcomeForExitCode', () => {
  test.each([
    [0, 'done'],
    [1, 'failed'],
    [3, 'refused'],
    [4, 'parked'],
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

  const parked = (workerId = 'w-1'): RunState => ({ ...at('exited', 1), outcome: 'parked', workerId });

  test('task.resume: only for the worker this agent parked, and only after that park', () => {
    expect(decideDispatch(parked(), { resumeWorkerId: 'w-1' })).toEqual({ action: 'start', attempt: 2, resumeWorkerId: 'w-1' });
    expect(decideDispatch(parked(), { resumeWorkerId: 'w-2' })).toEqual({ action: 'ignore', reason: 'not_parked' });
    expect(decideDispatch({ ...parked(), outcome: 'failed' }, { resumeWorkerId: 'w-1' })).toEqual({ action: 'ignore', reason: 'not_parked' });
    expect(decideDispatch(INITIAL_STATE, { resumeWorkerId: 'w-1' })).toEqual({ action: 'ignore', reason: 'not_parked' });
  });

  test('duplicate task.resume: the first starts the resume, the second sees a live run', () => {
    expect(decideDispatch({ ...parked(), status: 'starting', attempt: 2 }, { resumeWorkerId: 'w-1' })).toEqual({ action: 'ignore', reason: 'already_live' });
    // ...and once that resume has exited (done), a late duplicate is not a second resume.
    expect(decideDispatch({ ...parked(), status: 'exited', outcome: 'done', attempt: 2 }, { resumeWorkerId: 'w-1' })).toEqual({ action: 'ignore', reason: 'not_parked' });
  });
});

describe('resumable runs config', () => {
  test('needs the var and the binding', () => {
    expect(resumableRunsEnabled({ RESUMABLE_RUNS: '1', SNAPSHOTS: {} })).toBe(true);
    expect(resumableRunsEnabled({ RESUMABLE_RUNS: '1' })).toBe(false);
    expect(resumableRunsEnabled({ SNAPSHOTS: {} })).toBe(false);
  });

  test('container env: BUILDD_ONCE_PARK and the snapshot URL only when on', () => {
    const off = buildContainerEnv({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'k' }, 'bldt_task');
    expect('BUILDD_ONCE_PARK' in off).toBe(false);
    const on = buildContainerEnv({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'k', RESUMABLE_RUNS: '1' }, 'bldt_task');
    expect(on.BUILDD_ONCE_PARK).toBe('1');
    expect(on.BUILDD_SNAPSHOT_URL).toBe('https://buildd-snapshots.invalid');
    expect('BUILDD_WARM_REPO' in on).toBe(false);
  });

  test('commands: a resume continues the named worker; the orphan park names the task and worker', () => {
    expect(runnerCommand('task-1')).toEqual(['buildd-once', '--task', 'task-1']);
    expect(runnerCommand('task-1', 'w-1')).toEqual(['buildd-once', '--resume-worker', 'w-1', '--task', 'task-1']);
    expect(orphanParkCommand('task-1', 'w-1')).toEqual(['buildd-once', '--park-orphan', 'w-1', '--task', 'task-1']);
  });

  test('parseParkedLine', () => {
    expect(parseParkedLine('BUILDD_PARKED=w-1')).toBe('w-1');
    expect(parseParkedLine('BUILDD_PARKED=../x')).toBeNull();
    expect(parseParkedLine('x BUILDD_PARKED=w-1')).toBeNull();
  });
});

describe('crashReportAction', () => {
  test('only a crash with a known worker is reported', () => {
    expect(crashReportAction('crashed', 'w-1')).toBe('report');
    expect(crashReportAction('crashed', undefined)).toBe('skip_no_worker');
    for (const o of ['done', 'failed', 'refused', 'usage', 'parked'] as const) {
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
  test('minimal env with a placeholder model key, the cloud marker and no GitHub token', () => {
    const env = buildContainerEnv({ BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_API_KEY: 'bld_test' }, 'bldt_task');
    expect(env).toEqual({
      ...IMAGE_ENV,
      BUILDD_SERVER: 'http://127.0.0.1:9',
      BUILDD_API_KEY: 'bldt_task',
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY_PLACEHOLDER,
      BUILDD_DISABLE_AUTO_UPDATE: '1',
      BUILDD_EXECUTOR: 'cloud',
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('security: no model or GitHub secret reaches the container, whatever the Worker holds', () => {
    // Every secret the Worker could hold is in the source; only the per-task
    // token may come out the other side.
    const workerEnv = {
      BUILDD_SERVER: 'https://buildd.example', BUILDD_API_KEY: 'bld_runner_key',
      DISPATCH_TOKEN: 'dispatch-secret', AI_GATEWAY_TOKEN: 'gw-secret',
      AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw',
      ANTHROPIC_DIRECT_API_KEY: 'sk-ant-direct-secret', ALLOW_DIRECT_ANTHROPIC: '1',
      MODEL_PROXY_URL: 'https://litellm.example.com', MODEL_PROXY_KEY: 'proxy-secret-key', MODEL_PROXY_AUTH_HEADER: 'x-api-key',
      ANTHROPIC_API_KEY: 'sk-ant-real', ANTHROPIC_AUTH_TOKEN: 'oauth-real', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real',
      GH_TOKEN: 'ghs_real', GITHUB_TOKEN: 'ghs_real', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
      MODEL: 'm', PUSHER_KEY: 'pk',
    };
    const env = buildContainerEnv(workerEnv as never, 'bldt_task');
    const values = Object.values(env).join('\n');
    for (const secret of ['bld_runner_key', 'dispatch-secret', 'gw-secret', 'sk-ant-direct-secret', 'proxy-secret-key', 'litellm.example.com', 'sk-ant-real', 'oauth-real', 'ghs_real']) {
      expect(values).not.toContain(secret);
    }
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AI_GATEWAY_TOKEN', 'DISPATCH_TOKEN', 'ANTHROPIC_BASE_URL', 'MODEL_PROXY_URL', 'MODEL_PROXY_KEY', 'MODEL_PROXY_AUTH_HEADER']) {
      expect(key in env).toBe(false);
    }
    expect(env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_API_KEY_PLACEHOLDER);
    expect(env.BUILDD_EXECUTOR).toBe('cloud');
  });

  test('passes optional settings through only when set', () => {
    const env = buildContainerEnv({
      BUILDD_SERVER: 's', BUILDD_API_KEY: 'k', MODEL: '', PUSHER_KEY: 'pk',
    }, 'bldt_task');
    expect(env.PUSHER_KEY).toBe('pk');
    expect('MODEL' in env).toBe(false);
  });

  test('warm repos: the flag and the snapshot URL only when the Worker turned them on', () => {
    const off = buildContainerEnv({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'k' }, 'bldt_task');
    expect('BUILDD_WARM_REPO' in off).toBe(false);
    expect('BUILDD_SNAPSHOT_URL' in off).toBe(false);
    expect('BUILDD_WARM_REPO' in buildContainerEnv({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'k', WARM_REPOS: '0' }, 'bldt_task')).toBe(false);
    const on = buildContainerEnv({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'k', WARM_REPOS: '1' }, 'bldt_task');
    expect(on.BUILDD_WARM_REPO).toBe('1');
    expect(on.BUILDD_SNAPSHOT_URL).toBe('https://buildd-snapshots.invalid');
  });

  test('warmReposEnabled needs both the var and the R2 binding', () => {
    expect(warmReposEnabled({ WARM_REPOS: '1', SNAPSHOTS: {} })).toBe(true);
    expect(warmReposEnabled({ WARM_REPOS: '1' })).toBe(false);
    expect(warmReposEnabled({ SNAPSHOTS: {} })).toBe(false);
    expect(warmReposEnabled({ WARM_REPOS: 'yes', SNAPSHOTS: {} })).toBe(false);
  });

  test('refuses to build without a server (the runner would default to production)', () => {
    expect(() => buildContainerEnv({ BUILDD_API_KEY: 'k' }, 'bldt_task')).toThrow(/BUILDD_SERVER/);
  });

  test('security: refuses any container credential that is not a per-task token', () => {
    for (const token of ['bld_runner_key', '', 'k', undefined]) {
      expect(() => buildContainerEnv({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'bld_runner_key' }, token as never)).toThrow(/per-task token/);
    }
  });

  test('the token is minted with the runner key, for exactly this task', () => {
    const { url, init } = taskTokenRequest({ BUILDD_SERVER: 'https://buildd.example/', BUILDD_API_KEY: 'bld_k' }, 't-1');
    expect(url).toBe('https://buildd.example/api/runner/task-token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bld_k');
    expect(JSON.parse(init.body as string)).toEqual({ taskId: 't-1' });
    expect(() => taskTokenRequest({ BUILDD_SERVER: 's' }, 't-1')).toThrow(/BUILDD_API_KEY/);
  });

  test('a mint response must carry a per-task token for this task', () => {
    expect(parseTaskTokenResponse({ token: 'bldt_x', taskId: 't-1' }, 't-1')).toBe('bldt_x');
    expect(() => parseTaskTokenResponse({ token: 'bld_x', taskId: 't-1' }, 't-1')).toThrow(/per-task token/);
    expect(() => parseTaskTokenResponse({ token: 'bldt_x', taskId: 't-2' }, 't-1')).toThrow(/different task/);
    expect(() => parseTaskTokenResponse(null, 't-1')).toThrow();
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

describe('IMAGE_ENV: the image ENV, passed explicitly (a Cloudflare exec does not inherit it)', () => {
  test('matches every ENV variable in apps/runner/Dockerfile.once', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const text = readFileSync(join(import.meta.dir, '..', '..', 'runner', 'Dockerfile.once'), 'utf8');
    const block = text.match(/^ENV ((?:.*\\\n)*.*)$/m)![1];
    const vars = Object.fromEntries(block.split(/\\\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    expect(IMAGE_ENV).toEqual(vars);
    expect(IMAGE_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  test('the container env carries it, and the run values win', () => {
    const env = buildContainerEnv({ BUILDD_SERVER: 'https://buildd.example' }, 'bldt_x');
    for (const [k, v] of Object.entries(IMAGE_ENV)) expect(env[k]).toBe(v);
    expect(env.BUILDD_API_KEY).toBe('bldt_x');
  });
});
