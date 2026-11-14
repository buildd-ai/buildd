/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-1, AC-2 (R-14..R-16). */
import { describe, expect, it } from 'bun:test';
import { evaluateRetirement, gateRetirementMode, resolveRetirementMode, RetirementWindowError } from '../skill-retirement-rule';

const DAY = 86_400_000;
const NOW = new Date('2026-11-05T00:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const skill = (o: Record<string, unknown>) => ({
  id: 's', slug: 's', enabled: true, isRole: false, pinned: false,
  createdAt: ago(200), lastClaimedAt: null as Date | null, lastRestoredAt: null as Date | null, ...o,
});

describe('skill retirement rule', () => {
  it('AC-1: only the long-unclaimed skill is archivable and a 3-day window is rejected', () => {
    const skills = [
      skill({ id: 'recent', slug: 'recent', lastClaimedAt: ago(2) }),
      skill({ id: 'young', slug: 'young', createdAt: ago(5) }),
      skill({ id: 'role', slug: 'builder' }),
      skill({ id: 'sched', slug: 'sched-skill' }),
      skill({ id: 'pinned', slug: 'pinned', pinned: true }),
      skill({ id: 'old', slug: 'old', lastClaimedAt: ago(90) }),
    ];
    const input = {
      skills, now: NOW, telemetryStartedAt: ago(120), mode: 'acting' as const,
      defaultRoleSlugs: ['builder'], scheduleSkillSlugs: ['sched-skill'], activeTaskSkillSlugs: [] as string[],
      staleDays: 30, archiveDays: 60,
    };
    const out = evaluateRetirement(input);
    expect(out.archivable.map((s: { id: string }) => s.id)).toEqual(['old']);
    expect(() => evaluateRetirement({ ...input, staleDays: 3, archiveDays: 3 })).toThrow(RetirementWindowError);
  });

  it('AC-2: nothing is archivable before telemetry has run the full archive window', () => {
    const base = {
      skills: [skill({ id: 'never', slug: 'never', createdAt: ago(200) })],
      now: NOW, telemetryStartedAt: ago(20), defaultRoleSlugs: [] as string[],
      scheduleSkillSlugs: [] as string[], activeTaskSkillSlugs: [] as string[], staleDays: 30, archiveDays: 60,
    };
    const acting = evaluateRetirement({ ...base, mode: 'acting' });
    expect(acting.archivable).toEqual([]);
    const rec = evaluateRetirement({ ...base, mode: 'recording' });
    expect(rec.archivable).toEqual([]);
    expect(rec.report).toMatch(/telemetry/i);
  });
});

describe('resolveRetirementMode (R-16)', () => {
  const cfg = (mode: unknown) => ({ skillRetirement: { mode } } as any);
  it.each([['off', 'off'], ['recording', 'recording'], ['acting', 'acting']])('reads %s', (m, want) => {
    expect(resolveRetirementMode(cfg(m))).toBe(want);
  });
  it.each([[undefined], ['ACTING'], ['act'], [''], [1]])('unrecognised %p resolves to recording', m => {
    expect(resolveRetirementMode(cfg(m))).toBe('recording');
  });
  it('absent config resolves to recording', () => {
    expect(resolveRetirementMode(null)).toBe('recording');
    expect(resolveRetirementMode({})).toBe('recording');
  });
});

describe('gateRetirementMode (R-16)', () => {
  const base = { requested: 'acting' as const, platformApproved: true, recordingSince: ago(61), covered: 3, total: 4, now: NOW };
  it('grants acting when approved and the report has run the archive window', () => {
    expect(gateRetirementMode(base)).toEqual({ mode: 'acting', refused: null, coverage: '3/4 skills' });
  });
  it('refuses without platform approval', () => {
    expect(gateRetirementMode({ ...base, platformApproved: false }).mode).toBe('recording');
  });
  it('refuses when the report never ran', () => {
    expect(gateRetirementMode({ ...base, recordingSince: null }).refused).toContain('has not run');
  });
  it('refuses a short report and states coverage', () => {
    const r = gateRetirementMode({ ...base, recordingSince: ago(30) });
    expect(r.mode).toBe('recording');
    expect(r.refused).toContain('coverage 3/4 skills');
  });
  it('refuses when no skill was covered', () => {
    expect(gateRetirementMode({ ...base, covered: 0 }).mode).toBe('recording');
  });
  it('passes off and recording through', () => {
    expect(gateRetirementMode({ ...base, requested: 'off', platformApproved: false }).mode).toBe('off');
    expect(gateRetirementMode({ ...base, requested: 'recording' }).mode).toBe('recording');
  });
});
