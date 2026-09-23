import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { observe } from './observe';
import { loadConfig } from './config';
import { EMPTY_STATE } from './evidence';
import { dispatchStall } from './detectors';

/**
 * The single most dangerous bug this app could have is the snapshot builder
 * turning a failed read into an empty array. `cronRuns: []` reads as "the
 * platform ran its detector and found nothing"; `cronRuns: null` reads as "I
 * could not ask". Confusing them is how a monitor reports health while blind,
 * which is the failure class the responder exists for -- so it gets its own
 * test rather than being left to the type system.
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'responder-observe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(over: Record<string, string> = {}) {
  return loadConfig({
    BUILDD_RESPONDER_STATE_DIR: dir,
    // Port 1 is closed: every probe fails fast without leaving the machine.
    BUILDD_RESPONDER_APP_URL: 'http://127.0.0.1:1',
    BUILDD_RESPONDER_API_KEY: 'bld_illustrative',
    PUSHOVER_USER: 'u',
    PUSHOVER_TOKEN: 't',
    ...over,
  });
}

describe('observe distinguishes absence from emptiness', () => {
  test('an unconfigured cron feed is null with a reason, never an empty array', async () => {
    const { snapshot } = await observe(config(), EMPTY_STATE, Date.now());
    expect(snapshot.cronRuns).toBeNull();
    expect(snapshot.cronRunsError).toContain('BUILDD_RESPONDER_CRON_RUNS_URL');
  });

  test('a detector reading that snapshot says it cannot see, not that all is well', async () => {
    const now = Date.now();
    const { snapshot } = await observe(config(), EMPTY_STATE, now);
    const verdict = dispatchStall.evaluate(snapshot, now);
    expect(verdict.state).toBe('blind');
    expect(verdict.state).not.toBe('clear');
  });

  test('an unreachable cron feed is null with the transport error, not an empty array', async () => {
    const { snapshot } = await observe(
      config({ BUILDD_RESPONDER_CRON_RUNS_URL: 'postgres://nobody@127.0.0.1:1/nothing' }),
      EMPTY_STATE,
      Date.now(),
    );
    expect(snapshot.cronRuns).toBeNull();
    expect(typeof snapshot.cronRunsError).toBe('string');
  });
});

describe('observe never throws on an unreachable platform', () => {
  test('every probe failing yields a complete snapshot', async () => {
    const now = Date.now();
    const { snapshot, state } = await observe(config(), EMPTY_STATE, now);

    // The claim sample was still taken, and records the failure as data.
    expect(snapshot.claimSamples).toHaveLength(1);
    expect(snapshot.claimSamples[0]!.transport).toBe('unreachable');
    expect(snapshot.claimSamples[0]!.status).toBeNull();

    expect(snapshot.appVersion?.reachable).toBe(false);
    // Not configured, so absent rather than failed.
    expect(snapshot.runnerVersion).toBeNull();
    expect(state.samplingSince).toBe(snapshot.claimSamples[0]!.at);
  });

  test('samples accumulate across cycles so a rate has a denominator', async () => {
    const now = Date.now();
    const first = await observe(config(), EMPTY_STATE, now);
    const second = await observe(config(), first.state, now + 60_000);
    expect(second.snapshot.claimSamples).toHaveLength(2);
    expect(second.state.samplingSince).toBe(first.state.samplingSince);
  });
});
