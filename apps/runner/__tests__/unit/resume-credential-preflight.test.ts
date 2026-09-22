import { describe, test, expect } from 'bun:test';
import { staleResumeCredentialError } from '../../src/claude-auth';

/**
 * A worker parked on a question keeps its worktree and its transcript but NOT
 * its credential — `startSession`'s finally block deletes the per-worker config
 * dir and deregisters it from the broker, so nothing refreshes it while the
 * question waits. Resuming on the claim-time token then produced a session that
 * died "not logged in" after the human had already answered.
 *
 * AC-AQR-24 in docs/specs/answered-question-resume.md.
 */
describe('staleResumeCredentialError', () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
  const EXPIRED = new Date(NOW - 1000);
  const VALID = new Date(NOW + 60 * 60 * 1000);

  test('refuses a resume whose only token is an expired claim-time one', () => {
    const error = staleResumeCredentialError({
      isResume: true,
      fromBroker: false,
      tokenExpiresAt: EXPIRED,
      now: NOW,
    });
    expect(error).toBeTruthy();
    expect(error).toContain('Cannot resume');
    // Names the action the owner can take, not just the symptom.
    expect(error).toContain('Reconnect');
  });

  test('allows a resume on a broker-fetched token even if the claim-time one expired', () => {
    expect(staleResumeCredentialError({
      isResume: true,
      fromBroker: true,
      tokenExpiresAt: EXPIRED,
      now: NOW,
    })).toBeNull();
  });

  test('allows a resume on a claim-time token that is still valid', () => {
    expect(staleResumeCredentialError({
      isResume: true,
      fromBroker: false,
      tokenExpiresAt: VALID,
      now: NOW,
    })).toBeNull();
  });

  // Fresh sessions have a token minted moments earlier by the claim gate.
  // Hard-failing them on clock skew would break the common path to fix a rare one.
  test('never blocks a fresh (non-resume) session', () => {
    expect(staleResumeCredentialError({
      isResume: false,
      fromBroker: false,
      tokenExpiresAt: EXPIRED,
      now: NOW,
    })).toBeNull();
  });

  test('does not fail closed on an unknown expiry', () => {
    expect(staleResumeCredentialError({
      isResume: true,
      fromBroker: false,
      tokenExpiresAt: null,
      now: NOW,
    })).toBeNull();
    expect(staleResumeCredentialError({
      isResume: true,
      fromBroker: false,
      tokenExpiresAt: undefined,
      now: NOW,
    })).toBeNull();
  });

  test('treats an expiry exactly at now as expired', () => {
    expect(staleResumeCredentialError({
      isResume: true,
      fromBroker: false,
      tokenExpiresAt: new Date(NOW),
      now: NOW,
    })).toBeTruthy();
  });

  test('defaults to the current clock when none is injected', () => {
    expect(staleResumeCredentialError({
      isResume: true,
      fromBroker: false,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    })).toBeTruthy();
  });
});
