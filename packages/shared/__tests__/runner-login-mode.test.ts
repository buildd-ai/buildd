/**
 * How a runner's own logins share its slots (spec 34a48877 R-14, R-15,
 * AC-10, AC-11): the pure decision both the claim route and the runner use.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LOGIN_MODE, backendShares, nextLoginMode, parseLoginMode, pickLoginBackend, type LoginBackendInput } from '../src/runner-login-mode';

const both = { claudeUsable: true, codexUsable: true };

/** Claim `n` free tasks one by one, as the claim loop does, counting each. */
function claimRun(n: number, input: Omit<LoginBackendInput, 'running'>): Record<'claude' | 'codex', number> {
  const running = { claude: 0, codex: 0 };
  for (let i = 0; i < n; i++) {
    const b = pickLoginBackend({ ...input, running });
    if (b) running[b]++;
  }
  return running;
}

describe('login mode', () => {
  test('balanced is the default, and only the three modes parse', () => {
    expect(DEFAULT_LOGIN_MODE).toBe('balanced');
    expect(parseLoginMode('codex-first')).toBe('codex-first');
    expect(parseLoginMode('claude')).toBeNull();
    expect(parseLoginMode(undefined)).toBeNull();
  });

  test('b cycles balanced, claude-first, codex-first', () => {
    expect(nextLoginMode('balanced')).toBe('claude-first');
    expect(nextLoginMode('claude-first')).toBe('codex-first');
    expect(nextLoginMode('codex-first')).toBe('balanced');
  });

  test('shares: balanced gives Codex a third (at least 1); the first-modes let either take every slot', () => {
    expect(backendShares('balanced', 9)).toEqual({ claude: 6, codex: 3 });
    expect(backendShares('balanced', 1)).toEqual({ claude: 1, codex: 1 });
    expect(backendShares('balanced', 4)).toEqual({ claude: 2, codex: 2 });
    expect(backendShares('claude-first', 9)).toEqual({ claude: 9, codex: 9 });
    expect(backendShares('codex-first', 9)).toEqual({ claude: 9, codex: 9 });
  });

  test('AC-10: 9 slots, both logins usable, balanced: 3 on Codex and 6 on Claude', () => {
    expect(claimRun(9, { mode: 'balanced', slots: 9, ...both })).toEqual({ claude: 6, codex: 3 });
  });

  test('balanced spreads a short batch instead of filling one login first', () => {
    expect(claimRun(2, { mode: 'balanced', slots: 9, ...both })).toEqual({ claude: 1, codex: 1 });
  });

  test('AC-11: claude-first runs everything on Claude while it is usable, then on Codex', () => {
    expect(claimRun(9, { mode: 'claude-first', slots: 9, ...both })).toEqual({ claude: 9, codex: 0 });
    expect(claimRun(9, { mode: 'claude-first', slots: 9, claudeUsable: false, codexUsable: true })).toEqual({ claude: 0, codex: 9 });
  });

  test('codex-first mirrors it', () => {
    expect(claimRun(9, { mode: 'codex-first', slots: 9, ...both })).toEqual({ claude: 0, codex: 9 });
    expect(claimRun(3, { mode: 'codex-first', slots: 9, claudeUsable: true, codexUsable: false })).toEqual({ claude: 3, codex: 0 });
  });

  test('balanced: when one login cannot take work the other takes it all', () => {
    expect(claimRun(9, { mode: 'balanced', slots: 9, claudeUsable: false, codexUsable: true })).toEqual({ claude: 0, codex: 9 });
    expect(claimRun(9, { mode: 'balanced', slots: 9, claudeUsable: true, codexUsable: false })).toEqual({ claude: 9, codex: 0 });
  });

  test('neither usable: no pick', () => {
    expect(pickLoginBackend({ mode: 'balanced', slots: 9, running: { claude: 0, codex: 0 }, claudeUsable: false, codexUsable: false })).toBeNull();
  });

  test('an already full Codex share sends the next task to Claude', () => {
    expect(pickLoginBackend({ mode: 'balanced', slots: 9, running: { claude: 0, codex: 3 }, ...both })).toBe('claude');
  });
});
