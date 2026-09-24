/**
 * Claim/budget signals the runner derives from claim responses and session
 * results (audit items N2, N3, A.2, A.3).
 */
import { describe, test, expect } from 'bun:test';
import { isBudgetExhaustionError } from '@buildd/core/budget-error-classifier';
import {
  PAST_RESET_MIN_BACKOFF_MS,
  PAST_RESET_MAX_BACKOFF_MS,
  resumeAtForReset,
  ClaimHealth,
  CLAIM_5XX_DEGRADED_THRESHOLD,
  describeClaimErrorBody,
  withClaimHealthCheck,
  SESSION_BUDGET_CAP_ERROR,
  isSessionBudgetCapError,
  claudeSessionIsMetered,
  sdkMaxBudgetUsd,
  heartbeatState,
  SERVER_CONTACT_STALE_MS,
} from '../../src/claim-budget-signals';
import { classifyClaimError } from '../../src/claim-breaker';

describe('resumeAtForReset (N2: past budgetResetsAt must not hot-loop)', () => {
  const now = 1_000_000_000;

  test('a future reset is honoured as-is and clears the past-reset streak', () => {
    const r = resumeAtForReset(now + 120_000, now, 3);
    expect(r.atMs).toBe(now + 120_000);
    expect(r.pastStreak).toBe(0);
  });

  test('a past reset waits at least 30s', () => {
    const r = resumeAtForReset(now - 10_000, now, 0);
    expect(r.atMs - now).toBeGreaterThanOrEqual(PAST_RESET_MIN_BACKOFF_MS);
    expect(r.pastStreak).toBe(1);
  });

  test('a reset equal to now counts as past', () => {
    const r = resumeAtForReset(now, now, 0);
    expect(r.atMs - now).toBe(PAST_RESET_MIN_BACKOFF_MS);
  });

  test('consecutive past resets double the wait, capped', () => {
    const d = [0, 1, 2, 3].map(s => resumeAtForReset(now - 1, now, s).atMs - now);
    expect(d).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(resumeAtForReset(now - 1, now, 40).atMs - now).toBe(PAST_RESET_MAX_BACKOFF_MS);
  });
});

describe('ClaimHealth (N3: claim 5xx streak degrades health)', () => {
  test('three consecutive 5xx mark it degraded; the third reports the transition once', () => {
    const h = new ClaimHealth();
    expect(h.recordServerError(500).becameDegraded).toBe(false);
    expect(h.recordServerError(502).becameDegraded).toBe(false);
    expect(h.isDegraded()).toBe(false);
    const third = h.recordServerError(500);
    expect(third.becameDegraded).toBe(true);
    expect(third.streak).toBe(CLAIM_5XX_DEGRADED_THRESHOLD);
    expect(h.isDegraded()).toBe(true);
    expect(h.recordServerError(500).becameDegraded).toBe(false);
  });

  test('a successful claim resets the streak and reports recovery', () => {
    const h = new ClaimHealth();
    for (let i = 0; i < 3; i++) h.recordServerError(503);
    expect(h.recordSuccess()).toBe(true);
    expect(h.isDegraded()).toBe(false);
    expect(h.streak).toBe(0);
    expect(h.recordSuccess()).toBe(false);
  });

  test('a success between failures breaks the streak', () => {
    const h = new ClaimHealth();
    h.recordServerError(500);
    h.recordServerError(500);
    h.recordSuccess();
    h.recordServerError(500);
    expect(h.isDegraded()).toBe(false);
  });

  test('doctor report gains an error-level claim-health check when degraded', () => {
    const h = new ClaimHealth();
    const base = { timestamp: 't', checks: [], summary: { ok: 0, warn: 0, error: 0 } };
    const healthy = withClaimHealthCheck(base, h);
    expect(healthy.checks.find(c => c.name === 'claim-health')?.status).toBe('ok');
    expect(healthy.summary.ok).toBe(1);

    for (let i = 0; i < 3; i++) h.recordServerError(500);
    const degraded = withClaimHealthCheck(base, h);
    const check = degraded.checks.find(c => c.name === 'claim-health');
    expect(check?.status).toBe('error');
    expect(check?.message).toContain('degraded');
    expect(degraded.summary.error).toBe(1);
    // input not mutated
    expect(base.checks.length).toBe(0);
  });

  test('describeClaimErrorBody names an empty body instead of logging nothing', () => {
    expect(describeClaimErrorBody('')).toBe('(empty body)');
    expect(describeClaimErrorBody('   \n')).toBe('(empty body)');
    expect(describeClaimErrorBody('{"error":"boom"}')).toBe('{"error":"boom"}');
    expect(describeClaimErrorBody('x'.repeat(2000)).length).toBeLessThanOrEqual(501);
  });
});

describe('session budget cap (A.2) is not a provider wall', () => {
  test('the reported error text is not classified as budget exhaustion by the server', () => {
    expect(isBudgetExhaustionError(SESSION_BUDGET_CAP_ERROR)).toBe(false);
    expect(isBudgetExhaustionError(`${SESSION_BUDGET_CAP_ERROR}: $1.2000 > $1.0000`)).toBe(false);
  });

  test('the claim breaker does not pause a context for it', () => {
    expect(classifyClaimError(SESSION_BUDGET_CAP_ERROR.toLowerCase())).toBeNull();
    // Legacy runner wording for the same per-session cap.
    expect(classifyClaimError('budget limit exceeded (maxbudgetusd): $1.2 > $1.0')).toBeNull();
    expect(classifyClaimError('max budget reached')).toBeNull();
  });

  test('the breaker still pauses on a real provider wall', () => {
    expect(classifyClaimError("you've hit your session limit · resets 3am (utc)")).not.toBeNull();
  });

  test('isSessionBudgetCapError recognises current and legacy wording', () => {
    expect(isSessionBudgetCapError(SESSION_BUDGET_CAP_ERROR)).toBe(true);
    expect(isSessionBudgetCapError('Budget limit exceeded (maxBudgetUsd): $1 > $0.5')).toBe(true);
    expect(isSessionBudgetCapError('error_max_budget_usd')).toBe(true);
    expect(isSessionBudgetCapError("You've hit your session limit · resets 3am")).toBe(false);
    expect(isSessionBudgetCapError(undefined)).toBe(false);
  });
});

describe('sdkMaxBudgetUsd (A.3: no dollar cap on seat credentials)', () => {
  test('metered only when an API key or auth token is present', () => {
    expect(claudeSessionIsMetered({ ANTHROPIC_API_KEY: 'sk-x' })).toBe(true);
    expect(claudeSessionIsMetered({ ANTHROPIC_AUTH_TOKEN: 'tok' })).toBe(true);
    expect(claudeSessionIsMetered({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 'o' })).toBe(false);
    expect(claudeSessionIsMetered({})).toBe(false);
  });

  test('Claude on OAuth drops the cap; Claude on an API key keeps it', () => {
    expect(sdkMaxBudgetUsd(5, { backend: 'claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 'o' } })).toBeUndefined();
    expect(sdkMaxBudgetUsd(5, { backend: 'claude', env: { CLAUDE_CONFIG_DIR: '/x' } })).toBeUndefined();
    expect(sdkMaxBudgetUsd(5, { backend: 'claude', env: { ANTHROPIC_API_KEY: 'sk' } })).toBe(5);
  });

  test('Codex passes through (its backend decides by its own auth type)', () => {
    expect(sdkMaxBudgetUsd(5, { backend: 'codex', env: {} })).toBe(5);
  });

  test('no configured cap stays undefined', () => {
    expect(sdkMaxBudgetUsd(undefined, { backend: 'claude', env: { ANTHROPIC_API_KEY: 'sk' } })).toBeUndefined();
  });
});

describe('heartbeatState (N3 heartbeat)', () => {
  const now = 10_000_000;
  const degradedHealth = () => {
    const h = new ClaimHealth();
    for (let i = 0; i < CLAIM_5XX_DEGRADED_THRESHOLD; i++) h.recordServerError(503);
    return h;
  };

  test('recent contact and a healthy claim endpoint is alive', () => {
    expect(heartbeatState(now - 1_000, now, new ClaimHealth()).degraded).toBe(false);
  });

  test('a claim-5xx streak is DEGRADED even while server contact is recent', () => {
    const s = heartbeatState(now - 1_000, now, degradedHealth());
    expect(s.degraded).toBe(true);
    expect(s.reason).toContain('claim endpoint failing');
    expect(s.reason).toContain('503');
  });

  test('stale server contact is DEGRADED regardless of claim health', () => {
    const s = heartbeatState(now - SERVER_CONTACT_STALE_MS, now, new ClaimHealth());
    expect(s.degraded).toBe(true);
    expect(s.reason).toContain('no successful server contact');
  });

  test('never contacted is DEGRADED', () => {
    const s = heartbeatState(undefined, now, new ClaimHealth());
    expect(s.degraded).toBe(true);
    expect(s.reason).toContain('never');
  });
});
