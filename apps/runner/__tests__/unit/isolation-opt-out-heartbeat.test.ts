/**
 * An operator's BUILDD_DISABLE_SANDBOX=1 opt-out is a known isolation state,
 * not a missing probe (Living Spec "Runner isolation", R-3, R-11).
 *
 * Regression: the opt-out returned from isBwrapSupported() before it set the
 * probe time, so getBwrapProbeAt() stayed null for the life of the process.
 * The heartbeat attaches `environment.isolation` and `sandboxProbeAt` only once
 * the probe time is set, so an opted-out runner sent neither: Health read it as
 * "Sandbox never confirmed" and listed it as a problem, while every claim (which
 * always sends the record) still ran its trusted local work.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  WorkerManager,
  __resetBwrapSupportForTest,
  __setIsolationHostForTest,
  getBwrapProbeAt,
  getIsolationRecord,
  isBwrapSupported,
} from '../../src/workers';
import { isIsolationRecordCurrent } from '@buildd/shared';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.BUILDD_DISABLE_SANDBOX;
  process.env.BUILDD_DISABLE_SANDBOX = '1';
  __resetBwrapSupportForTest();
  __setIsolationHostForTest('linux');
});

afterEach(() => {
  if (saved === undefined) delete process.env.BUILDD_DISABLE_SANDBOX;
  else process.env.BUILDD_DISABLE_SANDBOX = saved;
  __resetBwrapSupportForTest();
  __setIsolationHostForTest(null);
});

describe('BUILDD_DISABLE_SANDBOX=1 is reported, not left unknown', () => {
  test('the boot probe records when it decided, even though it ran nothing', () => {
    expect(isBwrapSupported()).toBe(false);
    expect(getBwrapProbeAt()).not.toBeNull();
  });

  test('the record names the opt-out and is current for this process', () => {
    isBwrapSupported();
    const rec = getIsolationRecord();
    expect(rec.claude).toMatchObject({ mechanism: 'none', reason: 'opt_out' });
    expect(rec.codex['workspace-write']).toMatchObject({ mechanism: 'none', reason: 'opt_out' });
    expect(rec.reducedOptIn).toBe(true);
    expect(isIsolationRecordCurrent(rec)).toBe(true);
  });

  test('the heartbeat environment carries the isolation record', () => {
    isBwrapSupported(); // as WorkerManager's boot does
    const manager = Object.create(WorkerManager.prototype) as any;
    manager.config = { singleTask: true };
    manager.environment = { tools: [], envKeys: [], mcp: [], labels: {}, scannedAt: new Date().toISOString() };
    const env = manager.heartbeatEnvironment();
    expect(env.isolation?.claude).toMatchObject({ mechanism: 'none', reason: 'opt_out' });
    expect(env.isolation?.reducedOptIn).toBe(true);
  });
});
