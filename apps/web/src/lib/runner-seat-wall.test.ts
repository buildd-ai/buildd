import { describe, it, expect } from 'bun:test';
import {
  isMachineLoginWallError,
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
});
