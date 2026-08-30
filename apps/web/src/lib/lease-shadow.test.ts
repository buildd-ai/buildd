import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { logLeaseShadowDisagreements } from './stale-workers';

/**
 * Shadow phase deliverable.
 *
 * In this phase the lease decides nothing — the log line IS the product, because
 * it is the evidence the flip to lease authority will be made on. So the content
 * is asserted rather than left to chance.
 *
 * The two disagreement directions mean opposite things and must not be conflated:
 *  - legacy would kill, lease says alive  → a false-positive kill (evidence FOR)
 *  - lease would reclaim, legacy waits    → faster orphan reclamation (expected)
 */

const warnings: string[] = [];
const logs: string[] = [];
let origWarn: typeof console.warn;
let origLog: typeof console.log;

beforeEach(() => {
  warnings.length = 0;
  logs.length = 0;
  origWarn = console.warn;
  origLog = console.log;
  console.warn = ((...a: unknown[]) => { warnings.push(a.join(' ')); }) as any;
  console.log = ((...a: unknown[]) => { logs.push(a.join(' ')); }) as any;
});

afterEach(() => {
  console.warn = origWarn;
  console.log = origLog;
});

const future = () => new Date(Date.now() + 4 * 60 * 1000);
const past = () => new Date(Date.now() - 2 * 60 * 1000);

describe('logLeaseShadowDisagreements', () => {
  it('stays silent when both rules agree', () => {
    const r = logLeaseShadowDisagreements({
      accountId: 'acct-1',
      leaseExpiredNotLegacy: [],
      legacyStaleButLeaseValid: [],
    });

    expect(r.agreed).toBe(true);
    expect(warnings).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('warns loudly when the legacy rule is about to kill a worker holding a valid lease', () => {
    const r = logLeaseShadowDisagreements({
      accountId: 'acct-1',
      leaseExpiredNotLegacy: [],
      legacyStaleButLeaseValid: [
        { id: 'w-alive', taskId: 't-1', leaseExpiresAt: future() },
      ],
    });

    expect(r.agreed).toBe(false);
    // console.warn, not log: this is the false-positive kill the lease prevents.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[lease-shadow]');
    expect(warnings[0]).toContain('acct-1');
    expect(warnings[0]).toContain('w-alive');
    // Must be greppable as the high-signal direction and name the worker+task
    // so a real incident can be reconstructed from logs alone.
    expect(warnings[0]).toContain('VALID lease');
    expect(warnings[0]).toContain('t-1');
  });

  it('records the faster-reclamation direction at log level, not warn', () => {
    const r = logLeaseShadowDisagreements({
      accountId: 'acct-1',
      leaseExpiredNotLegacy: [
        { id: 'w-orphan', taskId: 't-2', leaseExpiresAt: past(), updatedAt: new Date() },
      ],
      legacyStaleButLeaseValid: [],
    });

    expect(r.agreed).toBe(false);
    // Expected and desirable, so it must not masquerade as a problem.
    expect(warnings).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('EXPIRED lease');
    expect(logs[0]).toContain('w-orphan');
  });

  it('reports both directions independently in one pass', () => {
    logLeaseShadowDisagreements({
      accountId: 'acct-1',
      leaseExpiredNotLegacy: [{ id: 'w-orphan', taskId: null, leaseExpiresAt: past() }],
      legacyStaleButLeaseValid: [{ id: 'w-alive', taskId: null, leaseExpiresAt: future() }],
    });

    expect(warnings).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(warnings[0]).toContain('w-alive');
    expect(logs[0]).toContain('w-orphan');
    // Never cross-contaminate the two populations.
    expect(warnings[0]).not.toContain('w-orphan');
    expect(logs[0]).not.toContain('w-alive');
  });

  it('survives a null leaseExpiresAt without throwing', () => {
    // Defensive: shadow observation must never be able to break reaping.
    expect(() => logLeaseShadowDisagreements({
      accountId: 'acct-1',
      leaseExpiredNotLegacy: [{ id: 'w-x', taskId: null, leaseExpiresAt: null }],
      legacyStaleButLeaseValid: [],
    })).not.toThrow();
  });
});
