import { describe, it, expect, mock } from 'bun:test';

// The module under test imports the database layer; only its pure rule is exercised here.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/github', () => ({ githubApi: async () => null }));

const { missionVerdictAuthority } = await import('./mission-outcome');

const M = 'mission-1';

describe('who records a mission-level verdict (Slice 12)', () => {
  it('allows a person', () => {
    expect(missionVerdictAuthority({ personId: 'u1', taskScoped: false, missionId: M })).toEqual({ ok: true, recordedBy: 'user:u1' });
  });

  it("allows the mission's own final verification task", () => {
    const r = missionVerdictAuthority({ personId: null, taskScoped: true, ownTask: { missionId: M, context: { finalVerification: { missionId: M } } }, missionId: M });
    expect(r.ok).toBe(true);
  });

  it('refuses a builder, fix or review task token of the same mission', () => {
    for (const context of [{}, { reviewOf: 'x' }, { surfaceFix: {} }, { specRepair: { missionId: M } }]) {
      expect(missionVerdictAuthority({ personId: null, taskScoped: true, ownTask: { missionId: M, context }, missionId: M }).ok).toBe(false);
    }
  });

  it("refuses another mission's final verification task", () => {
    const r = missionVerdictAuthority({ personId: null, taskScoped: true, ownTask: { missionId: 'other', context: { finalVerification: { missionId: 'other' } } }, missionId: M });
    expect(r.ok).toBe(false);
  });

  it('refuses an agent key with no person behind it', () => {
    expect(missionVerdictAuthority({ personId: null, taskScoped: false, missionId: M }).ok).toBe(false);
  });
});
