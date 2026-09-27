import { describe, expect, it } from 'bun:test';
import { steerPresence, steerTitle } from './steer-presence';

describe('steerTitle', () => {
  it('"<role> @ <runner> / <task label>"', () => {
    expect(steerTitle('Builder', 'atlas', 'rates service')).toBe('Builder @ atlas / rates service');
  });

  it('falls back to "Agent" with no role, and drops "@" with no runner yet', () => {
    expect(steerTitle(null, 'atlas', 'rates service')).toBe('Agent @ atlas / rates service');
    expect(steerTitle('Builder', null, 'rates service')).toBe('Builder / rates service');
    expect(steerTitle(null, null, 'rates service')).toBe('Agent / rates service');
  });
});

describe('steerPresence', () => {
  const worker = { runner: 'http://atlas.local:8766', accountId: 'acct-1' };

  it('names the runner, ages the heartbeat, and carries the turn and current action through', () => {
    const p = steerPresence(worker, { lastHeartbeatAt: Date.now() - 12_000, now: Date.now(), turns: 4, currentAction: 'Editing rates.ts' });
    expect(p.runnerLabel).toBe('atlas');
    expect(p.heartbeatLabel).toBe('<1m ago');
    expect(p.turnLabel).toBe('turn 4');
    expect(p.actionLabel).toBe('Editing rates.ts');
  });

  it('no heartbeat yet, no turn count yet: both read null, not a formatted zero', () => {
    const p = steerPresence(worker, { lastHeartbeatAt: null, now: Date.now(), turns: null, currentAction: null });
    expect(p.heartbeatLabel).toBeNull();
    expect(p.turnLabel).toBeNull();
    expect(p.actionLabel).toBeNull();
  });

  it('a clock skew where the heartbeat is "in the future" clamps to <1m, not a negative age', () => {
    const p = steerPresence(worker, { lastHeartbeatAt: Date.now() + 5_000, now: Date.now(), turns: 1, currentAction: null });
    expect(p.heartbeatLabel).toBe('<1m ago');
  });
});
