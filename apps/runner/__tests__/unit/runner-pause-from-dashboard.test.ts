/**
 * Pause from buildd.dev (spec 97b1bd0b R-18, AC-12): on the runner it is the
 * hold (`buildd hold`), with who changed it and when kept in config.json so
 * the later change wins against the dashboard, the same rule as slots
 * (spec 34a48877 R-21). Temp config files only; never ~/.buildd.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  RunnerHoldStore,
  readHoldFromConfig,
  readHoldMetaFromConfig,
  saveHoldToConfig,
  serverPauseToApply,
  holdOriginLine,
  runHoldCommand,
} from '../../src/runner-hold';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const configFile = () => join(mkdtempSync(join(tmpdir(), 'buildd-pause-')), 'config.json');
const quiet = { log: () => {}, warn: () => {} };
const noTimer = { setTimer: () => 0 as any, clearTimer: () => {} };

describe('who held or resumed, kept in config.json', () => {
  test('a dashboard Pause is saved with who and when, beside the API key, and read back on restart', () => {
    const file = configFile();
    writeFileSync(file, JSON.stringify({ apiKey: 'bld_fake' }));
    const store = new RunnerHoldStore({ configFile: file, logger: quiet, ...noTimer });
    store.hold(null, { changedAt: 2000, origin: 'dashboard', setBy: 'Max' });
    expect(readHoldFromConfig(file)?.until).toBeNull();
    expect(readHoldMetaFromConfig(file)).toEqual({ changedAt: 2000, origin: 'dashboard', setBy: 'Max' });
    expect(JSON.parse(readFileSync(file, 'utf8')).apiKey).toBe('bld_fake');
    const restarted = new RunnerHoldStore({ configFile: file, logger: quiet, ...noTimer });
    expect(restarted.isHeld()).toBe(true);
    expect(restarted.changeMeta()).toEqual({ changedAt: 2000, origin: 'dashboard', setBy: 'Max' });
  });

  test('a local hold or resume is recorded as this machine\'s, now', () => {
    let now = 5000;
    const store = new RunnerHoldStore({ configFile: configFile(), now: () => now, logger: quiet, ...noTimer });
    store.hold(null);
    expect(store.changeMeta()).toEqual({ changedAt: 5000, origin: 'machine', setBy: null });
    now = 6000;
    store.resume();
    expect(store.changeMeta()).toEqual({ changedAt: 6000, origin: 'machine', setBy: null });
  });

  test('a timed hold that runs out is a change on this machine', () => {
    let now = 1000;
    const store = new RunnerHoldStore({ configFile: configFile(), now: () => now, logger: quiet, ...noTimer });
    store.hold(60_000);
    now = 70_000;
    expect(store.isHeld()).toBe(false);
    expect(store.changeMeta()).toEqual({ changedAt: 70_000, origin: 'machine', setBy: null });
  });

  test('a hold that lapsed while the runner was down is recorded at its until', () => {
    const file = configFile();
    saveHoldToConfig(file, { since: new Date(1000).toISOString(), until: new Date(2000).toISOString() });
    const store = new RunnerHoldStore({ configFile: file, now: () => 9000, logger: quiet, ...noTimer });
    expect(store.isHeld()).toBe(false);
    expect(store.changeMeta()?.changedAt).toBe(2000);
  });

  test('`buildd hold` with no runner running records the change too', async () => {
    const file = configFile();
    const r = await runHoldCommand({ kind: 'hold', forArg: null }, { configFile: file, socketPath: '/nope', probe: async () => ({ state: 'absent' as const }), now: () => 3000 });
    expect(r.code).toBe(0);
    expect(readHoldMetaFromConfig(file)).toEqual({ changedAt: 3000, origin: 'machine', setBy: null });
  });
});

describe('a Pause or Resume in the heartbeat reply', () => {
  test('a change newer than the runner\'s own is taken; the state it is already in is not', () => {
    expect(serverPauseToApply({ paused: true, setBy: 'Max', setAt: 2000 }, { held: false, changedAt: 1000 })).toEqual({ paused: true, setBy: 'Max', setAt: 2000 });
    expect(serverPauseToApply({ paused: true, setBy: 'Max', setAt: 2000 }, { held: false, changedAt: null })).toMatchObject({ paused: true });
    expect(serverPauseToApply({ paused: false, setBy: 'Max', setAt: 2000 }, { held: true, changedAt: 1000 })).toMatchObject({ paused: false });
    expect(serverPauseToApply({ paused: true, setBy: 'Max', setAt: 2000 }, { held: true, changedAt: 1000 })).toBeNull();
  });

  test('a local change made after the dashboard one wins', () => {
    expect(serverPauseToApply({ paused: true, setBy: 'Max', setAt: 2000 }, { held: false, changedAt: 3000 })).toBeNull();
  });

  test('junk is ignored', () => {
    for (const bad of [null, undefined, {}, { paused: 'yes', setAt: 1 }, { paused: true }, { paused: true, setAt: 'now' }]) {
      expect(serverPauseToApply(bad, { held: false, changedAt: 0 })).toBeNull();
    }
  });

  test('the heartbeat sends the change time and reads the reply', async () => {
    const client = new BuilddClient({ builddServer: 'http://x', apiKey: 'k' } as LocalUIConfig);
    const bodies: any[] = [];
    (client as any).fetch = async (_p: string, init: any) => { bodies.push(JSON.parse(init.body)); return { desiredPause: { paused: true, setBy: 'Max', setAt: 2000 } }; };
    const reply = await client.sendHeartbeat('http://localhost:8766', 1, undefined, undefined, null, null, [], null, null, null, undefined, undefined, 3, 1000, 1500);
    expect(bodies[0].holdChangedAt).toBe(1500);
    expect(reply.desiredPause).toEqual({ paused: true, setBy: 'Max', setAt: 2000 });
  });
});

describe('where the Pause came from', () => {
  const now = new Date(2026, 9, 27, 12, 0).getTime();
  const at = new Date(2026, 9, 27, 10, 44).getTime();
  test('the one line, for buildd.dev and for this machine', () => {
    expect(holdOriginLine({ changedAt: at, origin: 'dashboard', setBy: 'Max' }, true, now)).toBe('paused on buildd.dev by Max, 10:44');
    expect(holdOriginLine({ changedAt: at, origin: 'dashboard', setBy: 'Max' }, false, now)).toBe('resumed on buildd.dev by Max, 10:44');
    expect(holdOriginLine({ changedAt: at, origin: 'machine', setBy: null }, true, now)).toBe('paused on this machine, 10:44');
    expect(holdOriginLine(null, true, now)).toBeNull();
  });
});
