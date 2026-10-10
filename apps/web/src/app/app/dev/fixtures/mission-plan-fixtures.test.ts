import { describe, expect, it } from 'bun:test';
import { planMissions } from '@/lib/mission-plan';
import { missionPlanFixtureData, parseMissionPlanVariant } from './mission-plan-fixtures';

describe('mission plan fixtures', () => {
  it('falls back to ready for an unknown variant', () => {
    expect(parseMissionPlanVariant('error')).toBe('error');
    expect(parseMissionPlanVariant('nope')).toBe('ready');
    expect(parseMissionPlanVariant(null)).toBe('ready');
  });

  it('ready data shows finish dates, a release cut, a dependency and a mission waiting on you', () => {
    const now = Date.UTC(2026, 9, 7, 12);
    const { inputs, plans } = missionPlanFixtureData(now);
    const rows = planMissions(inputs, now, plans);
    expect(rows.some(r => r.p50 != null)).toBe(true);
    expect(rows.some(r => r.fit?.kind === 'cut')).toBe(true);
    expect(rows.some(r => r.afterId != null)).toBe(true);
    expect(rows.some(r => r.noEstimate === 'waiting_on_you')).toBe(true);
  });
});
