/**
 * `buildd hold` / `buildd resume` (spec "Runner on your terminal" R-32, R-34,
 * AC-18, AC-19): a person's hold, saved in config.json beside the API key,
 * that survives a restart, lifts itself at `until`, and is its own state, so
 * an update drain or a breaker reset never lifts it.
 *
 * Everything runs against a temp config file and an injected socket; nothing
 * touches ~/.buildd or a real server.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseHoldDuration,
  readHoldFromConfig,
  saveHoldToConfig,
  RunnerHoldStore,
  initRunnerHold,
  claimsHeldByPerson,
  holdLine,
  resumeLine,
  runHoldCommand,
  runStopCommand,
  withRunnerHold,
  RUNNER_SOCKET_TIMEOUT_MS,
} from '../../src/runner-hold';
import { activeRunnerHold, isRunnerHoldActive, parseRunnerHold, withNormalizedRunnerHold } from '@buildd/shared';
import { UpdateDrain } from '../../src/update-drain';

let home: string;
let configFile: string;
const T0 = new Date(2026, 2, 10, 9, 12, 0).getTime();
const quiet = { log: () => {}, warn: () => {} };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buildd-hold-'));
  configFile = join(home, 'config.json');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  initRunnerHold(null);
});

describe('parseHoldDuration', () => {
  test('hours, minutes, seconds, days and combinations', () => {
    expect(parseHoldDuration('2h')).toBe(2 * 3_600_000);
    expect(parseHoldDuration('30m')).toBe(30 * 60_000);
    expect(parseHoldDuration('90s')).toBe(90_000);
    expect(parseHoldDuration('1d')).toBe(86_400_000);
    expect(parseHoldDuration('1h30m')).toBe(90 * 60_000);
    expect(parseHoldDuration(' 1m ')).toBe(60_000);
  });
  test('anything else is refused', () => {
    for (const bad of ['', '2', 'h', '-1h', '0m', 'soon', '2 hours', '1x']) expect(parseHoldDuration(bad)).toBeNull();
  });
});

describe('the shared hold shape', () => {
  test('parseRunnerHold keeps a valid hold and drops junk', () => {
    expect(parseRunnerHold({ since: new Date(T0).toISOString(), until: null })).toEqual({ since: new Date(T0).toISOString(), until: null });
    expect(parseRunnerHold({ since: 'nope' })).toBeNull();
    expect(parseRunnerHold({ since: new Date(T0).toISOString(), until: 'later' })).toBeNull();
    expect(parseRunnerHold('held')).toBeNull();
  });
  test('active until `until`, forever without one', () => {
    const since = new Date(T0).toISOString();
    expect(isRunnerHoldActive({ since, until: null }, T0 + 1e9)).toBe(true);
    expect(isRunnerHoldActive({ since, until: new Date(T0 + 60_000).toISOString() }, T0 + 59_000)).toBe(true);
    expect(isRunnerHoldActive({ since, until: new Date(T0 + 60_000).toISOString() }, T0 + 60_000)).toBe(false);
    expect(activeRunnerHold({ hold: { since, until: new Date(T0 - 1).toISOString() } }, T0)).toBeNull();
    expect(activeRunnerHold({ hold: { since, until: null } }, T0)).toEqual({ since, until: null });
  });
  test('withNormalizedRunnerHold strips an invalid hold and keeps the rest', () => {
    expect(withNormalizedRunnerHold({ labels: {}, hold: 'x' })).toEqual({ labels: {} });
    const env = { labels: {} };
    expect(withNormalizedRunnerHold(env)).toBe(env);
  });
});

describe('config.json', () => {
  test('saving keeps every other field and the file stays owner-only', () => {
    writeFileSync(configFile, JSON.stringify({ apiKey: 'bld_x', name: 'atlas' }));
    saveHoldToConfig(configFile, { since: new Date(T0).toISOString(), until: null });
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(cfg).toEqual({ apiKey: 'bld_x', name: 'atlas', hold: { since: new Date(T0).toISOString(), until: null } });
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    saveHoldToConfig(configFile, null);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ apiKey: 'bld_x', name: 'atlas' });
  });
  test('an unreadable config is never overwritten', () => {
    writeFileSync(configFile, 'not json');
    expect(() => saveHoldToConfig(configFile, { since: new Date(T0).toISOString(), until: null })).toThrow(/not a JSON object/);
    expect(readFileSync(configFile, 'utf8')).toBe('not json');
  });
  test('reading a missing or junk hold gives none', () => {
    expect(readHoldFromConfig(configFile)).toBeNull();
    writeFileSync(configFile, JSON.stringify({ hold: { since: 'x' } }));
    expect(readHoldFromConfig(configFile)).toBeNull();
  });
});

describe('RunnerHoldStore', () => {
  test('a hold survives a restart: a new store over the same file is still held (AC-18)', () => {
    const a = new RunnerHoldStore({ configFile, now: () => T0 });
    a.hold(null);
    a.dispose();
    const b = new RunnerHoldStore({ configFile, now: () => T0 + 3_600_000 });
    expect(b.isHeld()).toBe(true);
    expect(b.current()?.since).toBe(new Date(T0).toISOString());
    b.dispose();
  });

  test('--for lifts itself at until, clears the config and says so (AC-19)', () => {
    let now = T0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const store = new RunnerHoldStore({
      configFile,
      now: () => now,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length as any; },
      clearTimer: () => {},
    });
    const changes: Array<unknown> = [];
    store.onChange(h => changes.push(h));
    store.hold(60_000);
    expect(store.isHeld()).toBe(true);
    expect(timers.at(-1)!.ms).toBe(60_000);
    now = T0 + 60_000;
    timers.at(-1)!.fn();
    expect(store.isHeld()).toBe(false);
    expect(readHoldFromConfig(configFile)).toBeNull();
    expect(changes.at(-1)).toBeNull();
    store.dispose();
  });

  test('a lapsed hold read at start is cleared, not obeyed', () => {
    saveHoldToConfig(configFile, { since: new Date(T0).toISOString(), until: new Date(T0 + 60_000).toISOString() });
    const store = new RunnerHoldStore({ configFile, now: () => T0 + 120_000 });
    expect(store.isHeld()).toBe(false);
    expect(readHoldFromConfig(configFile)).toBeNull();
    store.dispose();
  });

  test('holding again keeps the first since and takes the new until', () => {
    let now = T0;
    const store = new RunnerHoldStore({ configFile, now: () => now });
    store.hold(null);
    now = T0 + 10 * 60_000;
    const h = store.hold(30 * 60_000);
    expect(h.since).toBe(new Date(T0).toISOString());
    expect(h.until).toBe(new Date(now + 30 * 60_000).toISOString());
    store.dispose();
  });

  test('resume lifts it and returns what was lifted', () => {
    const store = new RunnerHoldStore({ configFile, now: () => T0 });
    expect(store.resume()).toBeNull();
    store.hold(null);
    expect(store.resume()?.since).toBe(new Date(T0).toISOString());
    expect(store.isHeld()).toBe(false);
    store.dispose();
  });

  test('a store that cannot write still holds in memory', () => {
    const store = new RunnerHoldStore({ io: { read: () => null, write: () => { throw new Error('read-only'); } }, now: () => T0, logger: quiet });
    store.hold(null);
    expect(store.isHeld()).toBe(true);
    store.dispose();
  });
});

describe('claimsHeldByPerson is its own gate, apart from the update drain', () => {
  test('false with no store (tests, CLI tools), true while held', () => {
    expect(claimsHeldByPerson()).toBe(false);
    const store = initRunnerHold({ configFile, now: () => T0 })!;
    store.hold(null);
    expect(claimsHeldByPerson(T0)).toBe(true);
  });

  test('an update drain opening and ending never lifts the hold', () => {
    const store = initRunnerHold({ configFile, now: () => T0 })!;
    store.hold(null);
    const d = new UpdateDrain({ windowMs: 60_000 }, quiet);
    d.tick({ eligible: true, busy: 2, now: T0 });
    d.tick({ eligible: false, busy: 2, now: T0 + 1000 });
    d.applyFailed('test');
    expect(claimsHeldByPerson(T0 + 2000)).toBe(true);
  });

  test('the claim loop consults it on the poll path and on the assignment path', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');
    const poll = src.slice(src.indexOf('async claimPendingTasks('), src.indexOf('async claimPendingTasks(') + 1500);
    const push = src.slice(src.indexOf('async claimAndStart('), src.indexOf('async claimAndStart(') + 1500);
    expect(poll).toContain('claimsHeldByPerson()');
    expect(push).toContain('claimsHeldByPerson()');
  });
});

describe('withRunnerHold (heartbeat and claim environment)', () => {
  test('adds the hold while held and an explicit null otherwise', () => {
    const env = { labels: {} } as any;
    const hold = { since: new Date(T0).toISOString(), until: null };
    expect(withRunnerHold(env, hold)).toEqual({ labels: {}, hold });
    expect(withRunnerHold(env, null)).toEqual({ labels: {}, hold: null });
    expect(withRunnerHold(undefined, hold)).toBeUndefined();
  });
});

describe('the one-line answers', () => {
  const at = (h: number, m: number) => new Date(2026, 2, 10, h, m).toISOString();
  test('hold says what changed and how many still run', () => {
    expect(holdLine({ since: at(9, 12), until: null }, 2, T0)).toBe('On hold: nothing new starts. 2 agents still running finish. buildd resume lifts it.');
    expect(holdLine({ since: at(9, 12), until: at(11, 12) }, 1, T0)).toBe('On hold until 11:12: nothing new starts. 1 agent still running finishes. buildd resume lifts it sooner.');
    expect(holdLine({ since: at(9, 12), until: null }, 0, T0)).toBe('On hold: nothing new starts. Nothing is running. buildd resume lifts it.');
  });
  test('resume says it takes work again', () => {
    expect(resumeLine(true, 2)).toBe('Resumed: looking for work now. 2 agents running.');
    expect(resumeLine(false, 0)).toBe('This runner was not on hold, so nothing changed. Nothing is running.');
  });
});

describe('runHoldCommand', () => {
  const absent = async () => ({ state: 'absent' as const });
  const live = async () => ({ state: 'live' as const, pid: 1, version: null });

  test('with a runner running, it asks the runner over its socket', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const r = await runHoldCommand({ kind: 'hold', forArg: '2h' }, {
      configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live,
      post: async (path, body) => { calls.push({ path, body }); return { status: 200, body: { hold: { since: new Date(T0).toISOString(), until: new Date(T0 + 7_200_000).toISOString() }, running: 2 } }; },
    });
    expect(calls).toEqual([{ path: '/api/hold', body: { forMs: 7_200_000 } }]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('On hold until 11:12: nothing new starts. 2 agents still running finish. buildd resume lifts it sooner.');
    expect(existsSync(configFile)).toBe(false);
  });

  test('resume over the socket lifts the hold and continues each paused agent in its own session (R-36)', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const r = await runHoldCommand({ kind: 'resume' }, {
      configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live,
      get: async () => ({ status: 200, body: { workers: [
        { id: 'w1', taskTitle: 'name override', status: 'waiting', waitingFor: { type: 'pause', prompt: 'Paused.' } },
        { id: 'w2', taskTitle: 'installer hint', status: 'waiting', waitingFor: { type: 'question', prompt: 'Which?' } },
        { id: 'w3', taskTitle: 'single instance', status: 'working' },
      ] } }),
      post: async (path, body) => { posts.push({ path, body }); return { status: 200, body: { hold: null, wasHeld: true, running: 1 } }; },
    });
    expect(posts).toEqual([
      { path: '/api/resume', body: {} },
      // The answer to its pause: the same path as Resume on the dashboard.
      { path: '/api/workers/w1/answer', body: { message: 'Resume' } },
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Resumed: looking for work now. 1 agent running.\nContinued "name override" in its own session.');
  });

  test('with no runner running, it writes the config and says the next start is held', async () => {
    writeFileSync(configFile, JSON.stringify({ apiKey: 'bld_x' }));
    const r = await runHoldCommand({ kind: 'hold', forArg: null }, { configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: absent, post: async () => { throw new Error('no socket'); } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('No runner is running on this machine. Saved: the next start is on hold until buildd resume.');
    expect(readHoldFromConfig(configFile)).toEqual({ since: new Date(T0).toISOString(), until: null });
    const back = await runHoldCommand({ kind: 'resume' }, { configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: absent, post: async () => { throw new Error('no socket'); } });
    expect(back.stdout).toBe('No runner is running on this machine. Saved: the next start takes new work.');
    expect(readHoldFromConfig(configFile)).toBeNull();
    expect(JSON.parse(readFileSync(configFile, 'utf8')).apiKey).toBe('bld_x');
  });

  test('a runner too old to hold: saved for its next start, and said so', async () => {
    const r = await runHoldCommand({ kind: 'hold', forArg: null }, { configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live, post: async () => ({ status: 404, body: { error: 'Not found' } }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('does not know hold yet');
    expect(readHoldFromConfig(configFile)).not.toBeNull();
  });

  test('a bad --for is a usage error and changes nothing', async () => {
    const r = await runHoldCommand({ kind: 'hold', forArg: 'soon' }, { configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: absent, post: async () => ({ status: 200, body: {} }) });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('--for takes a time like 2h, 30m or 1h30m');
    expect(existsSync(configFile)).toBe(false);
  });
});

describe('a busy runner gets time to answer (task 7d42431c)', () => {
  const live = async () => ({ state: 'live' as const, pid: 1, version: null });
  const slow = <T,>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms));

  test('the socket budget survives a busy runner (5s did not)', () => {
    expect(RUNNER_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(RUNNER_SOCKET_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    const src = readFileSync(join(import.meta.dir, '../../src/runner-hold.ts'), 'utf8');
    expect(src).not.toContain('AbortSignal.timeout(5_000)');
  });

  test('hold says it is waiting when the runner is slow to answer', async () => {
    const notices: string[] = [];
    const r = await runHoldCommand({ kind: 'hold', forArg: null }, {
      configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live,
      waitNotice: (line) => notices.push(line), waitNoticeAfterMs: 5,
      post: () => slow(40, { status: 200, body: { hold: { since: new Date(T0).toISOString(), until: null }, running: 1 } }),
    });
    expect(r.code).toBe(0);
    expect(notices).toEqual(['Waiting for the runner on this machine to answer (it is busy)...']);
  });

  test('no waiting line when the runner answers at once', async () => {
    const notices: string[] = [];
    await runHoldCommand({ kind: 'hold', forArg: null }, {
      configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live,
      waitNotice: (line) => notices.push(line), waitNoticeAfterMs: 200,
      post: async () => ({ status: 200, body: { hold: { since: new Date(T0).toISOString(), until: null }, running: 0 } }),
    });
    expect(notices).toEqual([]);
  });

  test('stop says it is waiting too', async () => {
    const notices: string[] = [];
    const r = await runStopCommand({ yes: true }, {
      configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live,
      waitNotice: (line) => notices.push(line), waitNoticeAfterMs: 5,
      get: () => slow(40, { status: 200, body: { workers: [] } }),
      post: async () => ({ status: 200, body: {} }),
    });
    expect(r.code).toBe(0);
    expect(notices).toEqual(['Waiting for the runner on this machine to answer (it is busy)...']);
  });
});

describe('runStopCommand (R-36, AC-20, AC-22)', () => {
  const live = async () => ({ state: 'live' as const, pid: 1, version: null });
  const absent = async () => ({ state: 'absent' as const });
  const workers = [
    { id: 'w1', taskTitle: 'name override', status: 'working' },
    { id: 'w2', taskTitle: 'single instance', status: 'stale' },
    { id: 'w3', taskTitle: 'installer hint', status: 'waiting', waitingFor: { type: 'question', prompt: 'Which?' } },
    { id: 'w4', taskTitle: 'spec draft', status: 'done' },
  ];
  function harness(over: { failId?: string } = {}) {
    const posts: string[] = [];
    return {
      posts,
      deps: {
        configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: live,
        get: async (path: string) => { expect(path).toBe('/api/workers?view=top'); return { status: 200, body: { workers } }; },
        post: async (path: string) => {
          posts.push(path);
          if (path === '/api/hold') return { status: 200, body: { hold: { since: new Date(T0).toISOString(), until: null }, running: 2 } };
          const id = path.split('/')[3];
          return id === over.failId ? { status: 404, body: { error: 'worker is gone' } } : { status: 200, body: { ok: true } };
        },
      },
    };
  }

  test('--yes holds first, then pauses each running agent the way p does, one line each', async () => {
    const h = harness();
    const r = await runStopCommand({ yes: true }, h.deps);
    expect(h.posts).toEqual(['/api/hold', '/api/workers/w1/pause', '/api/workers/w2/pause']);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      'Paused "name override": it stops at its next safe point and keeps its session.',
      'Paused "single instance": it stops at its next safe point and keeps its session.',
      'On hold: nothing new starts. buildd resume lifts it and continues the paused agents.',
    ]);
  });

  test('without --yes it names the agents and asks; no means nothing changes', async () => {
    const h = harness();
    let asked = '';
    const r = await runStopCommand({ yes: false }, { ...h.deps, confirm: async (q: string) => { asked = q; return false; } });
    expect(asked).toBe('Pause 2 agents (name override, single instance) and hold this runner? Each keeps its worktree, branch and session; buildd resume continues them. [y/N] ');
    expect(h.posts).toEqual([]);
    expect(r.stdout).toBe('Nothing stopped. The runner is as it was.');
  });

  test('--abort ends every live agent the way x does, after saying what is lost (AC-22)', async () => {
    const h = harness();
    let asked = '';
    const r = await runStopCommand({ yes: false, abort: true }, { ...h.deps, confirm: async (q: string) => { asked = q; return true; } });
    expect(asked).toBe('End 3 agents (name override, single instance, installer hint) and hold this runner? Their unpushed work and conversation are lost, and each task starts again from its last pushed commit. [y/N] ');
    expect(h.posts).toEqual(['/api/hold', '/api/workers/w1/stop', '/api/workers/w2/stop', '/api/workers/w3/stop']);
    expect(r.stdout.split('\n')).toEqual([
      'Stopped "name override".',
      'Stopped "single instance".',
      'Stopped "installer hint".',
      'On hold: nothing new starts until buildd resume.',
    ]);
  });

  test('--abort --yes asks nothing', async () => {
    const h = harness();
    await runStopCommand({ yes: true, abort: true }, { ...h.deps, confirm: async () => { throw new Error('asked'); } });
    expect(h.posts).toHaveLength(4);
  });

  test('no terminal to ask in and no --yes: refused, nothing changes', async () => {
    const h = harness();
    const r = await runStopCommand({ yes: false }, { ...h.deps, confirm: null });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('buildd stop asks before it stops agents. Run it in a terminal, or add --yes. Nothing stopped.');
    expect(h.posts).toEqual([]);
  });

  test('a refused pause says why and exits non-zero; the rest still pause', async () => {
    const h = harness({ failId: 'w1' });
    const r = await runStopCommand({ yes: true }, h.deps);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Could not pause "name override": worker is gone (HTTP 404)');
    expect(h.posts).toContain('/api/workers/w2/pause');
  });

  test('nothing running: it still holds, and says so', async () => {
    const h = harness();
    const r = await runStopCommand({ yes: true }, { ...h.deps, get: async () => ({ status: 200, body: { workers: [] } }) });
    expect(h.posts).toEqual(['/api/hold']);
    expect(r.stdout).toBe('Nothing is running. On hold: nothing new starts. buildd resume lifts it and continues the paused agents.');
  });

  test('no runner running: nothing to stop, saved on hold for the next start', async () => {
    const r = await runStopCommand({ yes: true }, { configFile, socketPath: join(home, 'runner.sock'), now: () => T0, probe: absent, get: async () => { throw new Error('x'); }, post: async () => { throw new Error('x'); } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('No runner is running on this machine, so no agent is running. Saved: the next start is on hold until buildd resume.');
    expect(readHoldFromConfig(configFile)).not.toBeNull();
  });
});
