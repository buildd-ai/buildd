/**
 * Slots: how many agents this runner runs at once (spec c7410e76 R-43..R-46,
 * AC-27..AC-29). The CLI against a fake socket and a temp config.json, the
 * words, which agents a lower N makes extra, and the pause queue's order.
 * Never the real ~/.buildd.
 */
import { expectOwnerOnlyPath } from '../windows-acl';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readSlotsMeta, serverSlotsToApply, slotsOriginLine, SlotPauseQueue, applySlots, classifySlotsArgs, slotResumes, parseSlots, pickExtras, readSlotsFromConfig, runSlotsCommand, saveSlotsToConfig,
  slotsChangeLine, slotsSource, slotsStatusLine, type SlotAgent,
} from '../../src/runner-slots';
import { classifyCliArgs } from '../../src/cli-args';
import { BuilddClient } from '../../src/buildd';
import { WorkerManager } from '../../src/workers';
import type { LocalUIConfig } from '../../src/types';

const home = () => mkdtempSync(join(tmpdir(), 'buildd-slots-'));
const live = async () => ({ state: 'live' as const });
const absent = async () => ({ state: 'absent' as const });

const AGENTS: SlotAgent[] = [
  { id: 'w-1', title: 'oldest', status: 'working', startedAt: 1_000 },
  { id: 'w-2', title: 'second', status: 'working', startedAt: 2_000 },
  { id: 'w-3', title: 'third', status: 'stale', startedAt: 3_000 },
  { id: 'w-4', title: 'newest', status: 'working', startedAt: 4_000 },
  { id: 'w-q', title: 'asking', status: 'waiting', startedAt: 5_000 },
];

describe('words', () => {
  test('buildd slots alone says N, how many run, and where N comes from (R-43)', () => {
    expect(slotsStatusLine(6, 2, 'config')).toBe('6 slots (set in ~/.buildd/config.json): 2 running, 4 free.');
    expect(slotsStatusLine(1, 1, 'default')).toBe('1 slot (the default): 1 running, 0 free.');
    expect(slotsSource({ maxConcurrent: 4 }, { MAX_CONCURRENT: '9' })).toBe('config');
    expect(slotsSource({}, { MAX_CONCURRENT: '9' })).toBe('env');
    expect(slotsSource({}, {})).toBe('default');
  });

  test('lowering below the running count lets them finish, in the spec\'s words (R-45)', () => {
    expect(slotsChangeLine(4, 6)).toBe('6 running, slots now 4: they finish, nothing new starts until 3 run.');
    expect(slotsChangeLine(1, 2)).toBe('2 running, slots now 1: they finish, nothing new starts until none run.');
    expect(slotsChangeLine(4, 1)).toBe('Slots now 4: 1 running, 3 free, looking for work for them now.');
    expect(slotsChangeLine(2, 2)).toBe('Slots now 2: 2 running, 0 free.');
    expect(slotsChangeLine(2, 4, 'pause', 2)).toContain('paused the 2 newest agents');
    expect(slotsChangeLine(2, 3, 'abort', 1)).toContain('ended the newest agent');
  });

  test('a slot count is a whole number from 0 to 50', () => {
    expect(parseSlots('4')).toBe(4);
    expect(parseSlots(50)).toBe(50);
    for (const bad of ['-1', '2.5', 'four', '51', '', -1, 3.5]) expect(parseSlots(bad)).toBeNull();
  });
});

describe('extras and the pause queue (R-45, R-46, AC-29)', () => {
  test('the extras are the most recently started working agents; a question or a pause is not one', () => {
    expect(pickExtras(AGENTS, 2).map(a => a.id)).toEqual(['w-4', 'w-3']);
    expect(pickExtras(AGENTS, 4)).toEqual([]);
    expect(pickExtras(AGENTS, 1).map(a => a.id)).toEqual(['w-4', 'w-3', 'w-2']);
  });

  test('paused extras continue oldest pause first', () => {
    const q = new SlotPauseQueue();
    q.add('w-4', 200);
    q.add('w-3', 100);
    q.add('w-3', 300);
    expect(q.list()).toEqual(['w-3', 'w-4']);
    q.remove('w-3');
    expect(q.list()).toEqual(['w-4']);
    expect(q.size).toBe(1);
  });
});

describe('config.json (R-43, AC-28)', () => {
  test('N is saved beside the other fields, owner-only, and read back', () => {
    const dir = home();
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ apiKey: 'bld_fake', runnerName: 'atlas' }));
    saveSlotsToConfig(file, 2);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ apiKey: 'bld_fake', runnerName: 'atlas', maxConcurrent: 2, slotsOrigin: 'machine', slotsSetBy: null });
    expect(readSlotsMeta(file)).toMatchObject({ origin: 'machine', setBy: null });
    expect(readSlotsFromConfig(file)).toBe(2);
    expectOwnerOnlyPath(file, 0o600);
  });

  test('an unreadable config.json is never overwritten', async () => {
    const dir = home();
    const file = join(dir, 'config.json');
    writeFileSync(file, '{not json');
    const r = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'finish', yes: false }, { configFile: file, socketPath: join(dir, 'runner.sock'), probe: absent });
    expect(r.code).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('buildd slots', () => {
  test('arguments', () => {
    expect(classifySlotsArgs([])).toEqual({ kind: 'show' });
    expect(classifySlotsArgs(['4'])).toEqual({ kind: 'set', raw: '4', mode: 'finish', yes: false });
    expect(classifySlotsArgs(['2', '--pause'])).toEqual({ kind: 'set', raw: '2', mode: 'pause', yes: false });
    expect(classifySlotsArgs(['--abort', '2', '--yes'])).toEqual({ kind: 'set', raw: '2', mode: 'abort', yes: true });
    expect(classifySlotsArgs(['2', '--pause', '--abort'])).toMatchObject({ kind: 'unknown' });
    expect(classifySlotsArgs(['--pause'])).toMatchObject({ kind: 'unknown' });
    expect(classifySlotsArgs(['2', '3'])).toMatchObject({ kind: 'unknown' });
    expect(classifyCliArgs(['bun', 'buildd', 'slots', '4', '--pause'])).toEqual({ kind: 'slots', cmd: { kind: 'set', raw: '4', mode: 'pause', yes: false } });
    expect(classifyCliArgs(['bun', 'buildd', 'slots', '--bogus'])).toEqual({ kind: 'unknown', arg: '--bogus' });
  });

  test('a bad number is refused with the usage, and nothing is written', async () => {
    const dir = home();
    const r = await runSlotsCommand({ kind: 'set', raw: 'lots', mode: 'finish', yes: false }, { configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: absent });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('buildd slots [<n>]');
  });

  test('with no runner it saves N for the next start', async () => {
    const dir = home();
    const file = join(dir, 'config.json');
    const r = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'finish', yes: false }, { configFile: file, socketPath: join(dir, 's'), probe: absent });
    expect(r).toEqual({ code: 0, stdout: 'No runner is running on this machine. Saved: the next start runs 2 at once.', stderr: '' });
    expect(readSlotsFromConfig(file)).toBe(2);
    const shown = await runSlotsCommand({ kind: 'show' }, { configFile: file, socketPath: join(dir, 's'), probe: absent, env: {} });
    expect(shown.stdout).toBe('No runner is running on this machine. The next start runs 2 at once (set in ~/.buildd/config.json).');
  });

  test('with a runner it asks that runner, and prints its line', async () => {
    const dir = home();
    const posts: Array<[string, Record<string, unknown>]> = [];
    const r = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'finish', yes: false }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      post: async (path, body) => { posts.push([path, body]); return { status: 200, body: { slots: 2, running: 4, line: slotsChangeLine(2, 4) } }; },
    });
    expect(posts).toEqual([['/api/slots', { slots: 2, extras: 'finish' }]]);
    expect(r.stdout).toBe('4 running, slots now 2: they finish, nothing new starts until 1 run.');
    const shown = await runSlotsCommand({ kind: 'show' }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      get: async () => ({ status: 200, body: { slots: 2, running: 4, source: 'config' } }),
    });
    expect(shown.stdout).toBe('2 slots (set in ~/.buildd/config.json): 4 running, 0 free.');
  });

  test('--abort asks first, naming the agents it ends, and a no changes nothing (R-46)', async () => {
    const dir = home();
    const posts: string[] = [];
    const asked: string[] = [];
    const deps = {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      get: async () => ({ status: 200, body: { workers: AGENTS.map(a => ({ id: a.id, taskTitle: a.title, status: a.status, startedAt: a.startedAt })) } }),
      post: async (path: string) => { posts.push(path); return { status: 200, body: { line: 'ok' } }; },
    };
    const no = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'abort', yes: false }, { ...deps, confirm: async (q) => { asked.push(q); return false; } });
    expect(asked[0]).toContain('End 2 agents (newest, third)');
    expect(asked[0]).toContain('unpushed work and conversation are lost');
    expect(no.stdout).toContain('Nothing changed');
    expect(posts).toEqual([]);
    const noTerminal = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'abort', yes: false }, { ...deps, confirm: null });
    expect(noTerminal.code).toBe(1);
    expect(posts).toEqual([]);
    const yes = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'abort', yes: true }, deps);
    expect(yes.code).toBe(0);
    expect(posts).toEqual(['/api/slots']);
  });

  test('a runner from before slots says to update it', async () => {
    const dir = home();
    const r = await runSlotsCommand({ kind: 'set', raw: '2', mode: 'finish', yes: false }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live, post: async () => ({ status: 404, body: 'Not found' }),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('update it');
  });
});

describe('the heartbeat reports N (R-43)', () => {
  test('maxConcurrent rides on the beat', async () => {
    let sent = '';
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? '');
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    }) as any;
    try {
      const client = new BuilddClient({ projectRoots: ['/tmp'], builddServer: 'http://127.0.0.1:1', apiKey: 'test-key', maxConcurrent: 6 } as LocalUIConfig);
      await client.sendHeartbeat('http://localhost:8766', 1, undefined, undefined, null, null, [], null, null, null, undefined, undefined, 6);
      expect(JSON.parse(sent).maxConcurrent).toBe(6);
      await client.sendHeartbeat('http://localhost:8766', 1);
      expect('maxConcurrent' in JSON.parse(sent)).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('/api/slots on the runner (R-44..R-46, AC-28, AC-29)', () => {
  const setup = (agents = AGENTS) => {
    const set: number[] = [];
    const acts: Array<[string, string]> = [];
    const pauses = new SlotPauseQueue();
    let t = 10_000;
    return {
      set, acts, pauses,
      deps: {
        setSlots: (n: number) => { set.push(n); },
        agents: () => agents,
        act: async (id: string, action: 'pause' | 'stop') => { acts.push([id, action]); return { ok: true }; },
        pauses,
        now: () => t++,
      },
    };
  };

  test('lowering lets every agent finish: nothing is paused or ended (AC-28)', async () => {
    const s = setup();
    const r = await applySlots({ slots: 2 }, s.deps);
    expect(r.status).toBe(200);
    expect(s.set).toEqual([2]);
    expect(s.acts).toEqual([]);
    expect(r.body.line).toBe('4 running, slots now 2: they finish, nothing new starts until 1 run.');
  });

  test('--pause pauses the newest extras and queues them to continue (AC-29)', async () => {
    const s = setup();
    const r = await applySlots({ slots: 2, extras: 'pause' }, s.deps);
    expect(s.acts).toEqual([['w-4', 'pause'], ['w-3', 'pause']]);
    expect(s.pauses.list()).toEqual(['w-4', 'w-3']);
    expect(r.body.acted).toBe(2);
  });

  test('--abort ends the newest extras the way x does', async () => {
    const s = setup();
    await applySlots({ slots: 3, extras: 'abort' }, s.deps);
    expect(s.acts).toEqual([['w-4', 'stop']]);
    expect(s.pauses.size).toBe(0);
  });

  test('a refused pause is said, not hidden', async () => {
    const s = setup();
    const r = await applySlots({ slots: 3, extras: 'pause' }, { ...s.deps, act: async () => ({ ok: false, why: 'Pause is not available for Codex runs (HTTP 409)' }) });
    expect(r.body.failed).toEqual(['Could not pause "newest": Pause is not available for Codex runs (HTTP 409)']);
    expect(s.pauses.size).toBe(0);
  });

  test('a bad value is refused and N is not touched', async () => {
    const s = setup();
    expect((await applySlots({ slots: -1 }, s.deps)).status).toBe(400);
    expect((await applySlots({}, s.deps)).status).toBe(400);
    expect(s.set).toEqual([]);
  });

  test('when slots free, paused extras continue oldest first, and an answered one is dropped (AC-29)', () => {
    const q = new SlotPauseQueue();
    q.add('w-a', 1);
    q.add('w-b', 2);
    q.add('w-c', 3);
    const paused = new Set(['w-b', 'w-c']);
    expect(slotResumes(q, id => paused.has(id), 1)).toEqual(['w-b']);
    expect(q.list()).toEqual(['w-b', 'w-c']);
    expect(slotResumes(q, id => paused.has(id), 0)).toEqual([]);
    expect(slotResumes(q, id => paused.has(id), 5)).toEqual(['w-b', 'w-c']);
  });
});

describe('slots set on buildd.dev (spec 34a48877 R-20..R-22, AC-15, AC-17)', () => {
  const NOW = new Date(2026, 9, 22, 15, 0).getTime();
  const at = (h: number, m: number) => new Date(2026, 9, 22, h, m).getTime();

  test('a dashboard value newer than the runner\'s own change is taken; an equal number is not', () => {
    expect(serverSlotsToApply({ slots: 12, setBy: 'Max', setAt: 2000 }, { slots: 5, changedAt: 1000 })).toEqual({ slots: 12, setBy: 'Max', setAt: 2000 });
    expect(serverSlotsToApply({ slots: 12, setBy: 'Max', setAt: 2000 }, { slots: 5, changedAt: null })).toMatchObject({ slots: 12 });
    expect(serverSlotsToApply({ slots: 5, setBy: 'Max', setAt: 2000 }, { slots: 5, changedAt: 1000 })).toBeNull();
  });

  test('a local change made after the dashboard one wins and is not overwritten', () => {
    expect(serverSlotsToApply({ slots: 12, setBy: 'Max', setAt: 2000 }, { slots: 6, changedAt: 3000 })).toBeNull();
  });

  test('junk in the reply is ignored', () => {
    for (const bad of [null, undefined, {}, { slots: -1, setAt: 1 }, { slots: 51, setAt: 1 }, { slots: 'x', setAt: 1 }, { slots: 8 }, { slots: 8, setAt: 'now' }]) {
      expect(serverSlotsToApply(bad, { slots: 5, changedAt: 0 })).toBeNull();
    }
  });

  test('a dashboard value is saved with who and when, survives a read, and says where it came from', () => {
    const file = join(home(), 'config.json');
    writeFileSync(file, JSON.stringify({ apiKey: 'bld_fake' }));
    saveSlotsToConfig(file, 12, { changedAt: at(14, 2), origin: 'dashboard', setBy: 'Max' });
    expect(readSlotsFromConfig(file)).toBe(12);
    const meta = readSlotsMeta(file);
    expect(meta).toEqual({ changedAt: at(14, 2), origin: 'dashboard', setBy: 'Max' });
    expect(slotsOriginLine(meta, NOW)).toBe('set on buildd.dev by Max, 14:02');
    expect(JSON.parse(readFileSync(file, 'utf8')).apiKey).toBe('bld_fake');
  });

  test('a later local change replaces the dashboard record', () => {
    const file = join(home(), 'config.json');
    saveSlotsToConfig(file, 12, { changedAt: at(14, 2), origin: 'dashboard', setBy: 'Max' });
    saveSlotsToConfig(file, 6);
    expect(readSlotsFromConfig(file)).toBe(6);
    expect(readSlotsMeta(file)?.origin).toBe('machine');
    expect(slotsOriginLine(readSlotsMeta(file), Date.now())).toMatch(/^set on this machine, \d\d:\d\d$/);
  });

  test('an older day reads as a date, and a number never recorded reads as nothing', () => {
    expect(slotsOriginLine({ changedAt: new Date(2026, 9, 17, 9, 0).getTime(), origin: 'machine', setBy: null }, NOW)).toBe('set on this machine, Oct 17');
    expect(slotsOriginLine(null)).toBeNull();
    const file = join(home(), 'config.json');
    writeFileSync(file, JSON.stringify({ maxConcurrent: 4 }));
    expect(readSlotsMeta(file)).toBeNull();
  });

  test('buildd slots says where N came from', async () => {
    const dir = home();
    const shown = await runSlotsCommand({ kind: 'show' }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      get: async () => ({ status: 200, body: { slots: 12, running: 3, source: 'config', origin: 'set on buildd.dev by Max, 14:02' } }),
    });
    expect(shown.stdout).toBe('12 slots (set on buildd.dev by Max, 14:02): 3 running, 9 free.');
  });

  test('the heartbeat carries the time of the runner\'s own change', async () => {
    const client = new BuilddClient({ builddServer: 'http://x', apiKey: 'k' } as LocalUIConfig);
    const bodies: any[] = [];
    (client as any).fetch = async (_p: string, init: any) => { bodies.push(JSON.parse(init.body)); return { viewerToken: 't', desiredSlots: { slots: 12, setBy: 'Max', setAt: 2000 } }; };
    const reply = await client.sendHeartbeat('http://localhost:8766', 1, undefined, undefined, null, null, [], null, null, null, undefined, undefined, 5, 1000);
    expect(bodies[0]).toMatchObject({ maxConcurrent: 5, slotsChangedAt: 1000 });
    expect(reply.desiredSlots).toEqual({ slots: 12, setBy: 'Max', setAt: 2000 });
  });
});

describe('the runner applies a dashboard value (R-20, R-21, AC-15, AC-17)', () => {
  const fake = (file: string, slots: number, changedAt?: number) => {
    const m = Object.create(WorkerManager.prototype) as any;
    m.config = { maxConcurrent: slots, slotsChangedAt: changedAt, slotsConfigFile: file };
    m.beats = 0;
    m.claims = 0;
    m.emit = () => {};
    m.sendHeartbeat = async () => { m.beats++; };
    m.claimPendingTasks = async () => { m.claims++; };
    m._refusalBackoff = { reset() {} };
    return m;
  };

  test('a raise is applied, saved in a temp config, reported, and starts claiming at once', () => {
    const file = join(home(), 'config.json');
    writeFileSync(file, JSON.stringify({ apiKey: 'bld_fake', maxConcurrent: 5 }));
    const m = fake(file, 5, 1000);
    expect(m.applyServerSlots({ slots: 12, setBy: 'Max', setAt: 2000 })).toBe(true);
    expect(m.config).toMatchObject({ maxConcurrent: 12, slotsChangedAt: 2000, slotsOrigin: 'dashboard', slotsSetBy: 'Max' });
    expect(readSlotsFromConfig(file)).toBe(12);
    expect(readSlotsMeta(file)).toEqual({ changedAt: 2000, origin: 'dashboard', setBy: 'Max' });
    expect(JSON.parse(readFileSync(file, 'utf8')).apiKey).toBe('bld_fake');
    expect(m.beats).toBe(1);
    expect(m.claims).toBe(1);
  });

  test('a lower is applied and starts no claim, so running agents finish', () => {
    const m = fake(join(home(), 'config.json'), 12, 1000);
    expect(m.applyServerSlots({ slots: 6, setBy: 'Max', setAt: 2000 })).toBe(true);
    expect(m.config.maxConcurrent).toBe(6);
    expect(m.claims).toBe(0);
  });

  test('a local change made after the dashboard one is not overwritten', () => {
    const file = join(home(), 'config.json');
    const m = fake(file, 6, 3000);
    expect(m.applyServerSlots({ slots: 12, setBy: 'Max', setAt: 2000 })).toBe(false);
    expect(m.config.maxConcurrent).toBe(6);
    expect(readSlotsMeta(file)).toBeNull();
  });

  test('an unreadable config.json is left alone and the number holds for this run', () => {
    const file = join(home(), 'config.json');
    writeFileSync(file, '{not json');
    const m = fake(file, 5);
    expect(m.applyServerSlots({ slots: 12, setBy: null, setAt: 2000 })).toBe(true);
    expect(m.config.maxConcurrent).toBe(12);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('concurrency 0 (spec 97b1bd0b R-18)', () => {
  test('0 is a real setting everywhere a number of slots is read', () => {
    expect(parseSlots(0)).toBe(0);
    expect(parseSlots('0')).toBe(0);
    expect(parseSlots(-1)).toBeNull();
    expect(slotsSource({ maxConcurrent: 0 }, {})).toBe('config');
    const file = join(home(), 'config.json');
    saveSlotsToConfig(file, 0, { changedAt: 2000, origin: 'dashboard', setBy: 'Max' });
    expect(readSlotsFromConfig(file)).toBe(0);
  });

  test('a dashboard 0 is taken from the reply', () => {
    expect(serverSlotsToApply({ slots: 0, setBy: 'Max', setAt: 2000 }, { slots: 5, changedAt: 1000 })).toEqual({ slots: 0, setBy: 'Max', setAt: 2000 });
  });

  test('the words for 0', () => {
    expect(slotsChangeLine(0, 2)).toBe('2 running, slots now 0: they finish, nothing new starts.');
    expect(slotsChangeLine(0, 0)).toBe('Slots now 0: 0 running, 0 free.');
    expect(slotsStatusLine(0, 0, 'config')).toBe('0 slots (set in ~/.buildd/config.json): 0 running, 0 free.');
  });

  test('buildd slots 0 is accepted', async () => {
    const dir = home();
    const file = join(dir, 'config.json');
    const r = await runSlotsCommand({ kind: 'set', raw: '0', mode: 'finish', yes: false }, { configFile: file, socketPath: join(dir, 's'), probe: absent });
    expect(r.code).toBe(0);
    expect(readSlotsFromConfig(file)).toBe(0);
  });

  test('the heartbeat sends 0, not nothing', async () => {
    const client = new BuilddClient({ builddServer: 'http://x', apiKey: 'k' } as LocalUIConfig);
    const bodies: any[] = [];
    (client as any).fetch = async (_p: string, init: any) => { bodies.push(JSON.parse(init.body)); return {}; };
    await client.sendHeartbeat('http://localhost:8766', 1, undefined, undefined, null, null, [], null, null, null, undefined, undefined, 0, 1000);
    expect(bodies[0].maxConcurrent).toBe(0);
  });

  test('/api/slots on the runner accepts 0', async () => {
    const set: number[] = [];
    const r = await applySlots({ slots: 0 }, { setSlots: n => set.push(n), agents: () => AGENTS, act: async () => ({ ok: true }), pauses: new SlotPauseQueue() });
    expect(r.status).toBe(200);
    expect(set).toEqual([0]);
  });
});
