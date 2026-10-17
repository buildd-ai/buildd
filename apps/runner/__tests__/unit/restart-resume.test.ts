/**
 * restart-resume.ts: what a service stop or restart does with running agents
 * (Living Spec "Runner on your terminal", R-37, R-38, AC-21).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/restart-resume.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_SAFE_POINT_MS,
  SHUTDOWN_CHECKPOINT_MS,
  claudeConfigDirs,
  claudeTranscriptExists,
  codexRolloutExists,
  commitShutdownCheckpoint,
  decideRestore,
  fsResumeProbe,
  installRunnerShutdown,
  installShutdownSignals,
  restartNewAttemptError,
  shutdownExitCode,
  type ResumeProbe,
} from '../../src/restart-resume';

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const all: ResumeProbe = { worktreeExists: () => true, claudeSessionExists: () => true, codexThreadExists: () => true };

describe('decideRestore', () => {
  const base = { id: 'w1', workspaceId: 'ws', worktreePath: '/wt', sessionId: 'sess-123456', taskBackend: 'claude' as const };

  test('worktree and session on disk: continue', () => {
    expect(decideRestore(base, all)).toEqual({ kind: 'continue' });
  });

  test('each missing piece is named', () => {
    expect(decideRestore({ ...base, worktreePath: undefined }, all)).toEqual({ kind: 'new_attempt', missing: ['its worktree'] });
    expect(decideRestore(base, { ...all, worktreeExists: () => false })).toEqual({ kind: 'new_attempt', missing: ['its worktree'] });
    expect(decideRestore({ ...base, sessionId: undefined }, all)).toEqual({ kind: 'new_attempt', missing: ['its session id'] });
    expect(decideRestore(base, { ...all, claudeSessionExists: () => false })).toEqual({ kind: 'new_attempt', missing: ['its session file'] });
  });

  test('Codex resumes by thread, never by a Claude session id', () => {
    const codex = { ...base, taskBackend: 'codex' as const, sessionId: undefined, codexThreadId: 'thread-123456' };
    expect(decideRestore(codex, { ...all, claudeSessionExists: () => false })).toEqual({ kind: 'continue' });
    expect(decideRestore(codex, { ...all, codexThreadExists: () => false })).toEqual({ kind: 'new_attempt', missing: ['its Codex thread'] });
    expect(decideRestore({ ...codex, codexThreadId: undefined }, all)).toEqual({ kind: 'new_attempt', missing: ['its Codex thread id'] });
  });
});

describe('restartNewAttemptError', () => {
  test('keeps the "Process restarted" prefix every reader knows, and names what was missing', () => {
    expect(restartNewAttemptError(['its session file'])).toBe(
      'Process restarted: its session file is gone, so it could not continue in its own session; the task starts again as a new attempt from its last pushed commit',
    );
    expect(restartNewAttemptError(['its worktree', 'its session file'])).toMatch(/^Process restarted: its worktree and its session file are gone/);
  });
});

describe('session files on disk', () => {
  test('a Claude transcript under any config dir, in any project folder', () => {
    const cfg = tmp('rr-claude-');
    mkdirSync(join(cfg, 'projects', '-tmp-wt-1'), { recursive: true });
    writeFileSync(join(cfg, 'projects', '-tmp-wt-1', 'sess-abcdef.jsonl'), '{}\n');
    expect(claudeTranscriptExists(['/nonexistent-dir', cfg], 'sess-abcdef')).toBe(true);
    expect(claudeTranscriptExists([cfg], 'sess-other1')).toBe(false);
    // A path-shaped id is never looked up.
    expect(claudeTranscriptExists([cfg], '../../etc/passwd')).toBe(false);
  });

  test('claudeConfigDirs: CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' })).toEqual(['/c', '/h/.claude']);
    expect(claudeConfigDirs({ HOME: '/h' })).toEqual(['/h/.claude']);
  });

  test('a Codex rollout carrying the thread id, under sessions/YYYY/MM/DD', () => {
    const home = tmp('rr-codex-');
    mkdirSync(join(home, 'sessions', '2026', '10', '16'), { recursive: true });
    writeFileSync(join(home, 'sessions', '2026', '10', '16', 'rollout-2026-10-16T09-00-00-thread-xyz789.jsonl'), '{}\n');
    expect(codexRolloutExists(home, 'thread-xyz789')).toBe(true);
    expect(codexRolloutExists(home, 'thread-nope00')).toBe(false);
    expect(codexRolloutExists(join(home, 'missing'), 'thread-xyz789')).toBe(false);
  });
});

describe('commitShutdownCheckpoint', () => {
  function repo(): string {
    const d = tmp('rr-git-');
    const g = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
    g('init', '-q', '-b', 'buildd/task-branch');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    return d;
  }
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

  test('commits uncommitted and untracked edits to the agent\'s own branch, locally', async () => {
    const d = repo();
    writeFileSync(join(d, 'edited.ts'), 'export const x = 1;\n');
    const cp = await commitShutdownCheckpoint(d, 'worker-12345678', 'buildd/task-branch');
    expect(cp.committed).toBe(true);
    expect(cp.sha).toBe(git(d, 'rev-parse', 'HEAD'));
    expect(git(d, 'status', '--porcelain')).toBe('');
    expect(git(d, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('buildd/task-branch');
    expect(git(d, 'log', '-1', '--format=%s')).toMatch(/^wip: checkpoint, the runner stopped/);
    expect(readFileSync(join(d, 'edited.ts'), 'utf-8')).toContain('x = 1');
    // Nothing to push to and nothing pushed: no remote was ever touched.
    expect(git(d, 'remote')).toBe('');
  });

  test('a clean worktree commits nothing', async () => {
    const d = repo();
    const head = git(d, 'rev-parse', 'HEAD');
    expect(await commitShutdownCheckpoint(d, 'worker-12345678', 'buildd/task-branch')).toEqual({ committed: false });
    expect(git(d, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('refuses a detached HEAD, another branch, or no branch on record: logs a reason, commits nothing', async () => {
    const d = repo();
    writeFileSync(join(d, 'edited.ts'), 'x\n');
    const head = git(d, 'rev-parse', 'HEAD');

    const other = await commitShutdownCheckpoint(d, 'worker-12345678', 'buildd/someone-else');
    expect(other.committed).toBe(false);
    expect(other.reason).toContain("not this worker's branch");

    const none = await commitShutdownCheckpoint(d, 'worker-12345678', undefined);
    expect(none.committed).toBe(false);

    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: d });
    const detached = await commitShutdownCheckpoint(d, 'worker-12345678', 'buildd/task-branch');
    expect(detached).toEqual({ committed: false, reason: 'HEAD is detached' });

    expect(git(d, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(d, 'status', '--porcelain')).toContain('edited.ts'); // the edits stay in the worktree
  });

  test('not a repository: no commit, a reason, and no throw', async () => {
    const cp = await commitShutdownCheckpoint(tmp('rr-norepo-'), 'worker-12345678', 'buildd/task-branch', 1_000);
    expect(cp.committed).toBe(false);
    expect(cp.reason).toBeTruthy();
  });
});

describe('the grace is bounded', () => {
  test('the runner exits on its own before launchd\'s default kill (20 s), and the grace fits inside', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(20_000);
    expect(SHUTDOWN_SAFE_POINT_MS + SHUTDOWN_CHECKPOINT_MS + 2_500).toBeLessThan(SHUTDOWN_DEADLINE_MS);
  });

  test('exit codes: 0 for the service manager, 130 for Ctrl-C', () => {
    expect(shutdownExitCode('SIGTERM')).toBe(0);
    expect(shutdownExitCode('SIGINT')).toBe(130);
  });
});

describe('installShutdownSignals', () => {
  function harness(pause: () => Promise<void>) {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pauses: string[] = [];
    installShutdownSignals({
      pause: async (sig) => { pauses.push(sig); await pause(); },
      exit: (c) => { exits.push(c); },
      log: () => {},
      on: (s, fn) => { handlers.set(s, fn); },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0; },
    });
    return { handlers, exits, timers, pauses };
  }

  test('SIGTERM pauses the agents, then exits 0', async () => {
    const h = harness(async () => {});
    h.handlers.get('SIGTERM')!();
    await new Promise(r => setTimeout(r, 0));
    expect(h.pauses).toEqual(['SIGTERM']);
    expect(h.exits).toEqual([0]);
  });

  test('a pause that hangs never blocks the exit: the deadline exits', async () => {
    const h = harness(() => new Promise<void>(() => {}));
    h.handlers.get('SIGTERM')!();
    expect(h.exits).toEqual([]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(SHUTDOWN_DEADLINE_MS);
    h.timers[0].fn();
    expect(h.exits).toEqual([0]);
  });

  test('a second Ctrl-C exits at once, without pausing again', async () => {
    const h = harness(() => new Promise<void>(() => {}));
    h.handlers.get('SIGINT')!();
    h.handlers.get('SIGINT')!();
    expect(h.pauses).toEqual(['SIGINT']);
    expect(h.exits).toEqual([130]);
  });
});

describe('a worker on a per-worker Claude config dir', () => {
  test('its session file there counts, so the restart continues it', () => {
    const root = tmp('rr-iso-');
    const own = join(root, 'ws1', 'claude', 'w1', 'projects', '-wt');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'sess-abcdef.jsonl'), '{}\n');
    const probe = fsResumeProbe({ workspaceIsolationRoot: root, env: { HOME: join(root, 'nohome') } });
    expect(probe.claudeSessionExists('sess-abcdef', { id: 'w1', workspaceId: 'ws1' })).toBe(true);
    // Another worker's dir is not this worker's.
    expect(probe.claudeSessionExists('sess-abcdef', { id: 'w2', workspaceId: 'ws1' })).toBe(false);
    expect(probe.claudeSessionExists('sess-abcdef')).toBe(false);
  });
});

describe('installRunnerShutdown: the broker release fits the deadline', () => {
  function run(opts: { pauseMs: number; deadlineMs: number; brokerReleaseMs: number }) {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let released = false;
    installRunnerShutdown({
      pauseAgents: () => new Promise(r => setTimeout(r, opts.pauseMs)),
      releaseBroker: async () => { released = true; },
      exit: (c) => { exits.push(c); },
      log: () => {},
      on: (s, fn) => { handlers.set(s, fn); },
      setTimer: () => 0,
      deadlineMs: opts.deadlineMs,
      brokerReleaseMs: opts.brokerReleaseMs,
    });
    return { handlers, exits, released: () => released };
  }

  test('with no time left after the pause, the release is skipped and the exit is immediate', async () => {
    const h = run({ pauseMs: 150, deadlineMs: 600, brokerReleaseMs: 5_000 });
    const t0 = Date.now();
    h.handlers.get('SIGTERM')!();
    while (h.exits.length === 0 && Date.now() - t0 < 4_000) await new Promise(r => setTimeout(r, 10));
    expect(h.exits).toEqual([0]);
    expect(h.released()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test('with time left, the release runs', async () => {
    const h = run({ pauseMs: 10, deadlineMs: 5_000, brokerReleaseMs: 1_000 });
    h.handlers.get('SIGTERM')!();
    const t0 = Date.now();
    while (h.exits.length === 0 && Date.now() - t0 < 4_000) await new Promise(r => setTimeout(r, 10));
    expect(h.released()).toBe(true);
  });
});
