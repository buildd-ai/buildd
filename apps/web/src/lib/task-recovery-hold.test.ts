/**
 * Credential holds (failure-incident-recovery §18.3). Pure planners only.
 */
import { describe, expect, it } from 'bun:test';
import {
  CREDENTIAL_HOLD_BUDGET,
  isActivelyHeld,
  planCredentialHold,
  readCredentialHold,
  releasedHoldContext,
  taskRecoverySentence,
} from './task-recovery-hold';

const NOW = '2026-10-11T12:00:00.000Z';
const CRED = { credentialKey: 'account:acc-1', shared: false, label: 'the Claude login on runner "laptop"' };

describe('planCredentialHold', () => {
  it('a first auth failure holds the task 15 minutes on its own branch', () => {
    const plan = planCredentialHold({ context: { retryCount: 0 }, credential: CRED, now: NOW, workerId: 'w1', branch: 'buildd/abc-fix', lastCommitSha: 'deadbeef', error: '401 OAuth access token is invalid' });
    expect(plan.startAt.toISOString()).toBe('2026-10-11T12:15:00.000Z');
    expect(plan.hold).toMatchObject({ credentialKey: 'account:acc-1', attempts: 1, exhausted: false, since: NOW, firstHeldAt: NOW });
    expect(plan.context.resumeBranch).toBe('buildd/abc-fix');
    expect(plan.context.lastCommitSha).toBe('deadbeef');
    expect(plan.context.retryCount).toBe(0);
    expect((plan.context.failureContext as any).errorType).toBe('auth_failure');
  });

  it('a repeat on the same credential continues the episode with a longer probe', () => {
    const first = planCredentialHold({ context: {}, credential: CRED, now: NOW });
    const later = '2026-10-11T12:20:00.000Z';
    const second = planCredentialHold({ context: releasedHoldContext(first.context, later, 'test'), credential: CRED, now: later });
    expect(second.hold.attempts).toBe(2);
    expect(second.hold.firstHeldAt).toBe(NOW);
    expect(second.hold.releasedAt).toBeUndefined();
    expect(second.startAt.toISOString()).toBe('2026-10-11T13:20:00.000Z');
  });

  it('the third failure exhausts the hold: no timed probe, still not failed', () => {
    let ctx: Record<string, unknown> = {};
    let plan = planCredentialHold({ context: ctx, credential: CRED, now: NOW });
    for (let i = 1; i < CREDENTIAL_HOLD_BUDGET; i++) {
      ctx = plan.context;
      plan = planCredentialHold({ context: ctx, credential: CRED, now: NOW });
    }
    expect(plan.hold.attempts).toBe(3);
    expect(plan.hold.exhausted).toBe(true);
    expect(plan.startAt.getTime() - Date.parse(NOW)).toBe(7 * 24 * 3_600_000);
  });

  it('a different credential starts a new episode', () => {
    const first = planCredentialHold({ context: {}, credential: CRED, now: NOW });
    const other = planCredentialHold({ context: first.context, credential: { ...CRED, credentialKey: 'secret:s1' }, now: NOW });
    expect(other.hold.attempts).toBe(1);
  });
});

describe('release and the member sentence', () => {
  it('a release keeps the hold as history and stops it reading as held', () => {
    const { context } = planCredentialHold({ context: {}, credential: CRED, now: NOW });
    expect(isActivelyHeld(context)).toBe(true);
    const released = releasedHoldContext(context, '2026-10-11T12:05:00.000Z', 'incident:abc');
    expect(isActivelyHeld(released)).toBe(false);
    expect(readCredentialHold(released)?.releasedBy).toBe('incident:abc');
    expect(taskRecoverySentence(released)).toBeNull();
  });

  it('says what it waits on and when it retries, never "failed"', () => {
    const { context } = planCredentialHold({ context: {}, credential: CRED, now: NOW });
    const s = taskRecoverySentence(context)!;
    expect(s).toContain('Waiting for a healthy credential');
    expect(s).toContain('12:15');
    expect(s).not.toMatch(/fail|resolved|fixed/i);
  });

  it('an exhausted hold names the reconnect', () => {
    let ctx: Record<string, unknown> = {};
    for (let i = 0; i < CREDENTIAL_HOLD_BUDGET; i++) ctx = planCredentialHold({ context: ctx, credential: CRED, now: NOW }).context;
    expect(taskRecoverySentence(ctx)).toContain('to be reconnected');
  });

  it('no hold, no sentence', () => {
    expect(taskRecoverySentence({})).toBeNull();
    expect(taskRecoverySentence(null)).toBeNull();
  });
});
