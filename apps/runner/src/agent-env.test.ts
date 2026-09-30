import { describe, it, expect } from 'bun:test';
import { buildAgentBaseEnv, RUNNER_ENV_PASSTHROUGH } from './agent-env';

const NO_BROWSER = { available: false, searched: [], attempts: [] };

describe('agent env allowlist', () => {
  // The container image (apps/runner/Dockerfile.once) sets this so Claude Code
  // makes no telemetry / error-report / auto-update calls through the egress
  // proxy. It only works if it reaches the agent subprocess.
  it('passes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC through', () => {
    expect(RUNNER_ENV_PASSTHROUGH.has('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(true);
    const env = buildAgentBaseEnv({ HOME: '/home/bun', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, NO_BROWSER);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('still drops runner coordination secrets', () => {
    const env = buildAgentBaseEnv({ HOME: '/home/bun', BUILDD_API_KEY: 'bld_x', BUILDD_SERVER: 'http://x' }, NO_BROWSER);
    expect(env.BUILDD_API_KEY).toBeUndefined();
    expect(env.BUILDD_SERVER).toBeUndefined();
  });
});
