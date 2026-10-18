import { describe, it, expect } from 'bun:test';
import { resolveClaudeRoute } from './claude-route-eligibility';

const NOW = Date.now();
const live = (authType?: 'oauth' | 'api') => ({ lastHeartbeatAt: new Date(NOW - 60_000).toISOString(), authType });
const key = (healthStatus: string) => ({ purpose: 'anthropic_api_key', healthStatus });

describe('resolveClaudeRoute', () => {
  it('AC-6: healthy local OAuth with an unavailable managed key is eligible, not blocked', () => {
    const r = resolveClaudeRoute([live('oauth')], [key('revoked')], NOW);
    expect(r.state).toBe('eligible');
    expect(r.eligibleVia).toEqual(['local_login']);
    expect(r.managedKey).toBe('unavailable');
    expect(r.summary).toContain('does not block');
  });
  it('managed key alone is eligible', () => {
    expect(resolveClaudeRoute([live('api')], [key('healthy')], NOW).eligibleVia).toEqual(['managed_key']);
  });
  it('no local login and a dead key is blocked', () => {
    expect(resolveClaudeRoute([live('api')], [key('degraded')], NOW).state).toBe('blocked');
  });
  it('an offline oauth runner is not a local login', () => {
    const old = { lastHeartbeatAt: new Date(NOW - 24 * 3600_000).toISOString(), authType: 'oauth' as const };
    expect(resolveClaudeRoute([old], [key('revoked')], NOW).state).toBe('blocked');
  });
  it('nothing known is unknown, not blocked', () => {
    expect(resolveClaudeRoute([], [], NOW).state).toBe('unknown');
  });
});
