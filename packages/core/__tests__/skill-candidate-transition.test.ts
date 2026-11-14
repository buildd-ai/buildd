/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-5 (R-4..R-6). */
import { describe, expect, it } from 'bun:test';
import { transitionSkillCandidate } from '../skill-candidate-transition';

const candidate = {
  id: 'c1', teamId: 't', workspaceId: 'w', slug: 'deploy-check', state: 'candidate' as const,
  sourceTaskCount: 5, sourceDayCount: 3,
};

describe('skill candidate transition', () => {
  it('AC-5: no timer, count, model verdict or agent token can promote or enable', () => {
    for (const actor of [
      { kind: 'timer' }, { kind: 'count' }, { kind: 'model' }, { kind: 'agent', token: 'bld_x' },
    ] as const) {
      const r = transitionSkillCandidate(candidate, 'promote', actor as never);
      expect(r.ok).toBe(false);
      expect(r.candidate.state).toBe('candidate');
      expect(r.skillRow).toBeUndefined();
    }
  });

  it('AC-5: only a person promotes, creating a disabled workspace skill', () => {
    const r = transitionSkillCandidate(candidate, 'promote', { kind: 'person', userId: 'u1' });
    expect(r.ok).toBe(true);
    expect(r.candidate.state).toBe('promoted');
    expect(r.skillRow).toMatchObject({ slug: 'deploy-check', enabled: false });
  });
});
