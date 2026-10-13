import { describe, it, expect } from 'bun:test';
import { componentsOf, rankCauses, scoreOf, tierOf, ORQ_RANK_WEIGHTS, type RankInput } from './rank';

const NOW = '2026-10-11T12:00:00.000Z';

function input(over: Partial<RankInput> = {}): RankInput {
  return {
    causeKey: 'c1:0000000000000000000a', family: 'path_overlap_stall', causeCode: 'path_overlap.blocker_open',
    anyCritical: false, selfHealthOpen: false, needsPerson: false, budgetExhausted: false, unknown: false,
    blockedNow: 0, blockedTaskHours24h: { value: 0, atLeast: false }, teams: 1, workspaces: 1, missions: 0,
    oldestOpenAgeH: 1, oldestFirstSeenAt: '2026-10-11T11:00:00.000Z', episodes24h: 0, prior6dMeanDaily: 0, reopens7d: 0,
    leverage: 'none', wasteUsd7d: { value: 0, atLeast: false }, override: null,
    ...over,
  };
}

describe('orq-rank-v1 tiers', () => {
  it('safety, then a person, then active, then watching', () => {
    expect(tierOf(input({ anyCritical: true })).tier).toBe(0);
    expect(tierOf(input({ causeCode: 'tenant_isolation.cross_team_read' })).tier).toBe(0);
    expect(tierOf(input({ selfHealthOpen: true })).tier).toBe(0);
    expect(tierOf(input({ needsPerson: true })).tier).toBe(1);
    expect(tierOf(input({ budgetExhausted: true })).tier).toBe(1);
    expect(tierOf(input({ blockedNow: 2 })).tier).toBe(2);
    expect(tierOf(input()).tier).toBe(3);
  });

  it('F-4: unknown evidence never sinks below Active', () => {
    expect(tierOf(input({ unknown: true })).tier).toBe(2);
  });
});

describe('orq-rank-v1 score', () => {
  it('weights sum to 100 and a maxed cause scores 100', () => {
    expect(Object.values(ORQ_RANK_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const max = input({
      blockedTaskHours24h: { value: 200, atLeast: false }, teams: 5, workspaces: 10, missions: 10, oldestOpenAgeH: 72,
      episodes24h: 10, prior6dMeanDaily: 1, reopens7d: 5, leverage: 'decision_or_repair', wasteUsd7d: { value: 50, atLeast: false },
    });
    expect(scoreOf(componentsOf(max))).toBe(100);
  });

  it('an unknown input scores at its lower bound and says so, never a silent 0', () => {
    const c = componentsOf(input({ leverage: null, blockedTaskHours24h: { value: 3, atLeast: true } }));
    expect(c.find(x => x.key === 'leverage')).toMatchObject({ value: 0, atLeast: true });
    expect(c.find(x => x.key === 'blockedWork')).toMatchObject({ atLeast: true });
    expect(c.find(x => x.key === 'blockedWork')!.value).toBeGreaterThan(0);
  });

  it('blocked work is log-scaled and capped at 200 task-hours', () => {
    const at = (h: number) => componentsOf(input({ blockedTaskHours24h: { value: h, atLeast: false } })).find(x => x.key === 'blockedWork')!.value;
    expect(at(400)).toBe(1);
    expect(at(10)!).toBeLessThan(at(100)!);
  });
});

describe('orq-rank-v1 order', () => {
  it('tier first, then score, then the tie-breakers down to causeKey', () => {
    const r = rankCauses([
      input({ causeKey: 'c1:b', oldestOpenAgeH: 50 }),
      input({ causeKey: 'c1:a', needsPerson: true }),
      input({ causeKey: 'c1:d' }),
      input({ causeKey: 'c1:c' }),
    ], NOW);
    expect(r.map(x => x.causeKey)).toEqual(['c1:a', 'c1:b', 'c1:c', 'c1:d']);
    expect(r.map(x => x.position)).toEqual([1, 2, 3, 4]);
  });

  it('an earlier first sighting breaks a score tie', () => {
    const r = rankCauses([
      input({ causeKey: 'c1:a', oldestFirstSeenAt: '2026-10-11T10:00:00.000Z' }),
      input({ causeKey: 'c1:b', oldestFirstSeenAt: '2026-10-11T09:00:00.000Z' }),
    ], NOW);
    expect(r[0].causeKey).toBe('c1:b');
  });

  it('an override moves a row within its tier only, and keeps the baseline position', () => {
    const r = rankCauses([
      input({ causeKey: 'c1:top', needsPerson: true }),
      input({ causeKey: 'c1:x', oldestOpenAgeH: 60 }),
      input({ causeKey: 'c1:pinned', override: { mode: 'pin_top', until: '2026-10-12T00:00:00.000Z' } }),
    ], NOW);
    expect(r.map(x => x.causeKey)).toEqual(['c1:top', 'c1:pinned', 'c1:x']);
    expect(r.find(x => x.causeKey === 'c1:pinned')!.baselinePosition).toBe(3);
    const expired = rankCauses([input({ causeKey: 'c1:x', oldestOpenAgeH: 60 }), input({ causeKey: 'c1:p', override: { mode: 'pin_top', until: '2026-10-11T11:00:00.000Z' } })], NOW);
    expect(expired[0].causeKey).toBe('c1:x');
  });

  it('why names the tier and the two largest contributions', () => {
    const [r] = rankCauses([input({ needsPerson: true, blockedTaskHours24h: { value: 41, atLeast: false }, teams: 3, oldestOpenAgeH: 2 })], NOW);
    expect(r.why).toBe('Needs a person: a decision is waiting. Blocks 41 task-hours today, affects 3 teams.');
  });
});
