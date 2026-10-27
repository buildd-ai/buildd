import { describe, it, expect } from 'bun:test';
import {
  callerSeatKeys,
  claudeLoginSeatKey,
  isMachineLoginWallError,
  parseClaudeLoginId,
  resolveRunnerSeatWallKey,
  runnerSeatKey,
  type RunnerSeatWallInput,
} from './runner-seat-wall';

const WEEKLY = "You've hit your weekly limit · resets Oct 16, 4am (UTC)";

const input = (over: Partial<RunnerSeatWallInput> = {}): RunnerSeatWallInput => ({
  backend: 'claude',
  error: WEEKLY,
  runner: 'headless://box-a',
  tenantId: null,
  ...over,
});

describe('runnerSeatKey', () => {
  it('is stable per runner id, differs between runners, and never echoes the id', () => {
    const a = runnerSeatKey('headless://box-a');
    expect(a).toBe(runnerSeatKey('headless://box-a'));
    expect(a).not.toBe(runnerSeatKey('headless://box-b'));
    expect(a).toMatch(/^runner:[0-9a-f]{32}$/);
    expect(a).not.toContain('box-a');
  });

  it('has no key for a caller that is not a named runner', () => {
    for (const r of [null, undefined, '', '  ', 'runner', 'mcp', 'mcp-unverified', 'system', 'external', 'openclaw']) {
      expect(runnerSeatKey(r)).toBeNull();
    }
  });
});

describe('isMachineLoginWallError', () => {
  it('matches the subscription session and weekly walls', () => {
    expect(isMachineLoginWallError(WEEKLY)).toBe(true);
    expect(isMachineLoginWallError("Claude Code returned an error result: You've hit your session limit · resets 4pm (UTC)")).toBe(true);
    expect(isMachineLoginWallError("You're out of extra usage · resets 3am (UTC)")).toBe(true);
  });

  it('does not match an API rate limit, a Codex wall or nothing', () => {
    expect(isMachineLoginWallError('429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit')).toBe(false);
    expect(isMachineLoginWallError("You've hit your usage limit. Try again at 3:45pm.")).toBe(false);
    expect(isMachineLoginWallError(null)).toBe(false);
    expect(isMachineLoginWallError('')).toBe(false);
  });
});

describe('resolveRunnerSeatWallKey', () => {
  const RUNNER = runnerSeatKey('headless://box-a');

  it('scopes a weekly or session wall to the runner that hit it', () => {
    expect(resolveRunnerSeatWallKey(input()).seatKey).toBe(RUNNER);
    expect(resolveRunnerSeatWallKey(input({ error: "You've hit your session limit · resets 4pm (UTC)" })).seatKey).toBe(RUNNER);
  });

  // R-10: a team never shares a subscription wall, whatever the run used.
  it('scopes the wall to the runner for every login the run reports, the stored team credential included', () => {
    for (const loginUsed of ['machine_login', 'machine_token', 'stored', null] as const) {
      expect(resolveRunnerSeatWallKey(input({ loginUsed })).seatKey).toBe(RUNNER);
    }
  });

  it('keeps tenant, Codex and unnamed-runner walls shared', () => {
    expect(resolveRunnerSeatWallKey(input({ tenantId: 'tenant-1' })).seatKey).toBeNull();
    expect(resolveRunnerSeatWallKey(input({ backend: 'codex' })).seatKey).toBeNull();
    expect(resolveRunnerSeatWallKey(input({ runner: 'runner' })).seatKey).toBeNull();
    expect(resolveRunnerSeatWallKey(input({ runner: null })).seatKey).toBeNull();
  });

  it('keeps an API-style rate limit shared', () => {
    const out = resolveRunnerSeatWallKey(input({ error: '429 rate_limit_error: per-minute rate limit' }));
    expect(out.seatKey).toBeNull();
  });

  // Two runners on one host can read one ~/.claude and so share one login.
  // The runner reports a one-way hash of the login's account id; the wall is
  // keyed on it so the first runner's wall holds both.
  describe('the login identity the run reports', () => {
    const LOGIN = 'a'.repeat(32);
    it('keys a machine-login wall on the login, not the runner', () => {
      const a = resolveRunnerSeatWallKey(input({ loginUsed: 'machine_login', loginId: LOGIN }));
      const b = resolveRunnerSeatWallKey(input({ runner: 'headless://box-b', loginUsed: 'machine_login', loginId: LOGIN }));
      expect(a.seatKey).toBe(claudeLoginSeatKey(LOGIN));
      expect(b.seatKey).toBe(a.seatKey);
      const other = resolveRunnerSeatWallKey(input({ loginUsed: 'machine_login', loginId: 'b'.repeat(32) }));
      expect(other.seatKey).not.toBe(a.seatKey);
    });

    it('falls back to the runner key when the login identity is unknown', () => {
      expect(resolveRunnerSeatWallKey(input({ loginUsed: 'machine_token', loginId: null })).seatKey).toBe(RUNNER);
    });

    it('keys a stored-credential run on its runner, not on a machine login identity', () => {
      expect(resolveRunnerSeatWallKey(input({ loginUsed: 'stored', loginId: LOGIN })).seatKey).toBe(RUNNER);
    });

    it('accepts only the 32-hex-character hash shape', () => {
      expect(parseClaudeLoginId(LOGIN)).toBe(LOGIN);
      for (const bad of [undefined, null, '', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(64), '00000000-0000-4000-8000-000000000000', 42]) {
        expect(parseClaudeLoginId(bad)).toBeNull();
      }
    });

    it("gives a claim both its login's key and its runner's key, login first", () => {
      expect(callerSeatKeys('headless://box-a', LOGIN)).toEqual([claudeLoginSeatKey(LOGIN), runnerSeatKey('headless://box-a')]);
      expect(callerSeatKeys('headless://box-a', null)).toEqual([runnerSeatKey('headless://box-a')]);
      // A caller that is no named runner reads every wall, whatever it reports.
      expect(callerSeatKeys('runner', LOGIN)).toBeNull();
    });
  });
});
