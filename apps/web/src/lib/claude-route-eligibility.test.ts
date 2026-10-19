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
  it('no local login and a dead key is inferred only, not blocked, without a scheduler decision', () => {
    const r = resolveClaudeRoute([live('api')], [key('degraded')], NOW);
    expect(r.state).toBe('unknown');
    expect(r.summary).toContain('not confirmed by the claim scheduler');
  });
  it('the same inputs are blocked once the scheduler recently refused for a credential', () => {
    const r = resolveClaudeRoute([live('api')], [key('degraded')], NOW, { state: 'blocked', kind: 'credential_unavailable' });
    expect(r.state).toBe('blocked');
  });
  it('a stale scheduler refusal does not make it blocked', () => {
    expect(resolveClaudeRoute([live('api')], [key('degraded')], NOW, { state: 'stale', kind: 'credential_unavailable' }).state).toBe('unknown');
  });
  it('an offline oauth runner is not a local login', () => {
    const old = { lastHeartbeatAt: new Date(NOW - 24 * 3600_000).toISOString(), authType: 'oauth' as const };
    const r = resolveClaudeRoute([old], [key('revoked')], NOW);
    expect(r.localLogin).toBe('none');
    expect(r.state).toBe('unknown');
  });
  it('nothing known is unknown, not blocked', () => {
    expect(resolveClaudeRoute([], [], NOW).state).toBe('unknown');
  });
});
