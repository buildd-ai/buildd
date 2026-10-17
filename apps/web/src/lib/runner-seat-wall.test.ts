import { describe, it, expect } from 'bun:test';
import {
  callerSeatKeys,
  claudeLoginSeatKey,
  isMachineLoginWallError,
  parseClaudeLoginId,
  resolveRunnerSeatWallKey,
  runnerSeatKey,
  type RunnerSeatWallDeps,
  type RunnerSeatWallInput,
} from './runner-seat-wall';

const WEEKLY = "You've hit your weekly limit · resets Oct 16, 4am (UTC)";

const input = (over: Partial<RunnerSeatWallInput> = {}): RunnerSeatWallInput => ({
  backend: 'claude',
  error: WEEKLY,
  runner: 'headless://box-a',
  claimedByCloud: false,
  tenantId: null,
  accountId: 'account-1',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  ...over,
});

const deps = (over: Partial<RunnerSeatWallDeps> = {}): RunnerSeatWallDeps => ({
  heartbeatModelAuthSource: async () => 'machine_login',
  teamClaudeCredentialVisible: async () => false,
  teamEndpointWins: async () => false,
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
  it("scopes a weekly wall to the runner when it ran on its own machine login and the team stores no Claude credential", async () => {
    const out = await resolveRunnerSeatWallKey(input(), deps());
    expect(out.seatKey).toBe(runnerSeatKey('headless://box-a'));
  });

  it('scopes a wall from a machine token (CLAUDE_CODE_OAUTH_TOKEN) the same way', async () => {
    const out = await resolveRunnerSeatWallKey(input(), deps({ heartbeatModelAuthSource: async () => 'machine_token' }));
    expect(out.seatKey).toBe(runnerSeatKey('headless://box-a'));
  });

  it('asks the heartbeat for exactly this account and runner', async () => {
    const seen: unknown[] = [];
    await resolveRunnerSeatWallKey(input(), deps({
      heartbeatModelAuthSource: async (accountId, runner) => { seen.push([accountId, runner]); return 'machine_login'; },
    }));
    expect(seen).toEqual([['account-1', 'headless://box-a']]);
  });

  // Fail-safe: a login identity we cannot establish keeps the account-wide wall.
  it('keeps the wall shared when the runner reports no model auth (an older runner)', async () => {
    const out = await resolveRunnerSeatWallKey(input(), deps({ heartbeatModelAuthSource: async () => null }));
    expect(out.seatKey).toBeNull();
  });

  it('keeps the wall shared when the runner reports an API key or no login', async () => {
    for (const source of ['api_key', 'none'] as const) {
      const out = await resolveRunnerSeatWallKey(input(), deps({ heartbeatModelAuthSource: async () => source }));
      expect(out.seatKey).toBeNull();
    }
  });

  it('keeps the wall shared when the team stores a Claude credential every runner may draw on', async () => {
    const out = await resolveRunnerSeatWallKey(input(), deps({ teamClaudeCredentialVisible: async () => true }));
    expect(out.seatKey).toBeNull();
  });

  it("keeps the wall shared when the team's agent model endpoint carries Claude", async () => {
    const out = await resolveRunnerSeatWallKey(input(), deps({ teamEndpointWins: async () => true }));
    expect(out.seatKey).toBeNull();
  });

  it('keeps tenant, Codex, cloud and unnamed-runner walls shared', async () => {
    expect((await resolveRunnerSeatWallKey(input({ tenantId: 'tenant-1' }), deps())).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input({ backend: 'codex' }), deps())).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input({ claimedByCloud: true }), deps())).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input({ runner: 'runner' }), deps())).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input({ runner: null }), deps())).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input({ teamId: null }), deps())).seatKey).toBeNull();
  });

  it('keeps an API-style rate limit shared even from a machine-login runner', async () => {
    const out = await resolveRunnerSeatWallKey(input({ error: '429 rate_limit_error' }), deps());
    expect(out.seatKey).toBeNull();
  });

  it('keeps the wall shared when any lookup fails', async () => {
    const boom = async () => { throw new Error('db down'); };
    expect((await resolveRunnerSeatWallKey(input(), deps({ heartbeatModelAuthSource: boom }))).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input(), deps({ teamClaudeCredentialVisible: boom }))).seatKey).toBeNull();
    expect((await resolveRunnerSeatWallKey(input(), deps({ teamEndpointWins: boom }))).seatKey).toBeNull();
  });

  // Spec "A runner" (34a48877) R-9, R-10, AC-1, AC-2, AC-3. The run itself says
  // which login it used. A runner on its own machine login
  // walls only itself, even when the team also stores a Claude credential that
  // this run did not use: one machine's session limit held every runner of the
  // team for hours because a stored token existed somewhere.
  describe('the login the run reports it used', () => {
    it("scopes a machine-login run's wall to its runner even though the team stores a Claude credential", async () => {
      for (const loginUsed of ['machine_login', 'machine_token'] as const) {
        const out = await resolveRunnerSeatWallKey(
          input({ loginUsed }),
          deps({ teamClaudeCredentialVisible: async () => true, teamEndpointWins: async () => true, heartbeatModelAuthSource: async () => null }),
        );
        expect(out.seatKey).toBe(runnerSeatKey('headless://box-a'));
      }
    });

    it('keeps the wall shared when the run used the stored team credential', async () => {
      const out = await resolveRunnerSeatWallKey(input({ loginUsed: 'stored' }), deps());
      expect(out.seatKey).toBeNull();
      expect(out.reason).toContain('stored');
    });

    it('still keeps tenant, Codex, cloud, unnamed-runner and API rate-limit walls shared', async () => {
      const m = { loginUsed: 'machine_login' as const };
      expect((await resolveRunnerSeatWallKey(input({ ...m, tenantId: 'tenant-1' }), deps())).seatKey).toBeNull();
      expect((await resolveRunnerSeatWallKey(input({ ...m, backend: 'codex' }), deps())).seatKey).toBeNull();
      expect((await resolveRunnerSeatWallKey(input({ ...m, claimedByCloud: true }), deps())).seatKey).toBeNull();
      expect((await resolveRunnerSeatWallKey(input({ ...m, runner: 'runner' }), deps())).seatKey).toBeNull();
      expect((await resolveRunnerSeatWallKey(input({ ...m, error: '429 rate_limit_error' }), deps())).seatKey).toBeNull();
    });

    it('needs no lookup when the run named its machine login', async () => {
      const boom = async () => { throw new Error('db down'); };
      const out = await resolveRunnerSeatWallKey(
        input({ loginUsed: 'machine_login' }),
        deps({ heartbeatModelAuthSource: boom, teamClaudeCredentialVisible: boom, teamEndpointWins: boom }),
      );
      expect(out.seatKey).toBe(runnerSeatKey('headless://box-a'));
    });
  });

  // Two runners on one Claude login (two processes reading one ~/.claude) share
  // that login's limit. The runner reports a one-way hash of the login's
  // account id; the wall is keyed on it so the first runner's wall holds both.
  describe('the login identity the run reports', () => {
    const LOGIN = 'a'.repeat(32);
    it('keys a machine-login wall on the login, not the runner', async () => {
      const a = await resolveRunnerSeatWallKey(input({ loginUsed: 'machine_login', loginId: LOGIN }), deps());
      const b = await resolveRunnerSeatWallKey(input({ runner: 'headless://box-b', loginUsed: 'machine_login', loginId: LOGIN }), deps());
      expect(a.seatKey).toBe(claudeLoginSeatKey(LOGIN));
      expect(b.seatKey).toBe(a.seatKey);
      const other = await resolveRunnerSeatWallKey(input({ loginUsed: 'machine_login', loginId: 'b'.repeat(32) }), deps());
      expect(other.seatKey).not.toBe(a.seatKey);
    });

    it('falls back to the runner key when the login identity is unknown', async () => {
      const out = await resolveRunnerSeatWallKey(input({ loginUsed: 'machine_token', loginId: null }), deps());
      expect(out.seatKey).toBe(runnerSeatKey('headless://box-a'));
    });

    it('ignores a login identity on a stored-credential run, which stays shared', async () => {
      const out = await resolveRunnerSeatWallKey(input({ loginUsed: 'stored', loginId: LOGIN }), deps());
      expect(out.seatKey).toBeNull();
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
