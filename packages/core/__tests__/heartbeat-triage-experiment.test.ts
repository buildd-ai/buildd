import { describe, it, expect } from 'bun:test';
import {
  decideHeartbeatTriageArm,
  parseHeartbeatTriageConfig,
  DEFAULT_TRIAGE_WAIT_MIN_CONFIDENCE,
} from '../heartbeat-triage-experiment';

const exp = (over: Record<string, unknown> = {}) => ({
  id: '5b0f6c1e-0000-4000-8000-0000000000aa', kind: 'heartbeat_triage', status: 'running',
  treatmentFraction: 0.5, policyVersion: 1, config: {}, ...over,
});

describe('heartbeat triage experiment', () => {
  it('draws per mission, deterministically, and only treatment may apply', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `mission-${i}`);
    const arms = ids.map(id => decideHeartbeatTriageArm(exp(), id));
    expect(ids.map(id => decideHeartbeatTriageArm(exp(), id).arm)).toEqual(arms.map(a => a.arm));
    const treated = arms.filter(a => a.arm === 'treatment');
    expect(treated.length).toBeGreaterThan(60);
    expect(treated.length).toBeLessThan(140);
    for (const a of arms) expect(a.apply).toBe(a.arm === 'treatment');
  });

  it('a new policy version redraws', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `mission-${i}`);
    const v1 = ids.map(id => decideHeartbeatTriageArm(exp(), id).arm);
    const v2 = ids.map(id => decideHeartbeatTriageArm(exp({ policyVersion: 2 }), id).arm);
    expect(v2).not.toEqual(v1);
  });

  it('reads the wait threshold from config, never below 0.5', () => {
    expect(parseHeartbeatTriageConfig({ waitMinConfidence: 0.95 }).waitMinConfidence).toBe(0.95);
    expect(parseHeartbeatTriageConfig({ waitMinConfidence: 0.3 }).waitMinConfidence).toBe(DEFAULT_TRIAGE_WAIT_MIN_CONFIDENCE);
    expect(parseHeartbeatTriageConfig('junk').minSamplePerArm).toBeGreaterThan(0);
    expect(decideHeartbeatTriageArm(exp({ config: { waitMinConfidence: 0.97 } }), 'm').waitMinConfidence).toBe(0.97);
  });
});
