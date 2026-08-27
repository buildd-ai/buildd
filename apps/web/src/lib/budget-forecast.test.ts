import { describe, it, expect } from 'bun:test';
import { groupOauthAccountsBySeatId, computeBurnRateConfidence, oauthEpisodeConfidence } from './budget-forecast';

describe('groupOauthAccountsBySeatId', () => {
  const makeAccount = (id: string, seatId: string | null, name = id) => ({
    id,
    name,
    seatId,
    budgetResetsAt: null as Date | null,
  });

  it('groups two accounts with the same seatId into one entry', () => {
    const accounts = [
      makeAccount('acc1', 'seat-A', 'laptop'),
      makeAccount('acc2', 'seat-A', 'desktop'),
    ];
    const groups = groupOauthAccountsBySeatId(accounts);
    expect(groups.size).toBe(1);
    const [group] = [...groups.values()];
    expect(group.map(a => a.id).sort()).toEqual(['acc1', 'acc2'].sort());
  });

  it('keeps accounts with different seatIds in separate groups', () => {
    const accounts = [
      makeAccount('acc1', 'seat-A'),
      makeAccount('acc2', 'seat-B'),
    ];
    const groups = groupOauthAccountsBySeatId(accounts);
    expect(groups.size).toBe(2);
  });

  it('treats null seatId accounts as individual groups', () => {
    const accounts = [
      makeAccount('acc1', null),
      makeAccount('acc2', null),
      makeAccount('acc3', 'seat-A'),
    ];
    const groups = groupOauthAccountsBySeatId(accounts);
    // acc1 and acc2 are individual (null seatId), acc3 is its own group
    expect(groups.size).toBe(3);
  });

  it('mixes null and shared seatId correctly', () => {
    const accounts = [
      makeAccount('acc1', 'seat-A', 'coder-workspace'),
      makeAccount('acc2', 'seat-A', 'moa-ops'),
      makeAccount('acc3', null, 'standalone'),
    ];
    const groups = groupOauthAccountsBySeatId(accounts);
    // seat-A group + standalone individual
    expect(groups.size).toBe(2);
    const seatAGroup = groups.get('seat-A');
    expect(seatAGroup).toBeDefined();
    expect(seatAGroup!.map(a => a.id).sort()).toEqual(['acc1', 'acc2'].sort());
    // standalone uses its own id as key
    const standaloneGroup = groups.get('acc3');
    expect(standaloneGroup).toBeDefined();
    expect(standaloneGroup!).toHaveLength(1);
  });

  it('handles empty accounts list', () => {
    const groups = groupOauthAccountsBySeatId([]);
    expect(groups.size).toBe(0);
  });
});

describe('computeBurnRateConfidence', () => {
  it('returns low for fewer than 5 samples', () => {
    expect(computeBurnRateConfidence([1, 2, 3])).toBe('low');
    expect(computeBurnRateConfidence([])).toBe('low');
  });

  it('returns low when all costs are zero', () => {
    expect(computeBurnRateConfidence([0, 0, 0, 0, 0])).toBe('low');
  });

  it('returns high for >20 low-variance samples', () => {
    const stable = Array.from({ length: 25 }, () => 1.0);
    expect(computeBurnRateConfidence(stable)).toBe('high');
  });

  it('returns medium for 5-20 low-variance samples', () => {
    const stable = Array.from({ length: 10 }, () => 1.0);
    expect(computeBurnRateConfidence(stable)).toBe('medium');
  });

  it('returns low for high-variance samples', () => {
    // Very spread values → high coefficient of variation
    const noisy = [0.01, 100, 0.01, 100, 0.01, 100];
    expect(computeBurnRateConfidence(noisy)).toBe('low');
  });
});

describe('oauthEpisodeConfidence', () => {
  it('returns null for none — learning state, no calibration yet', () => {
    expect(oauthEpisodeConfidence('none')).toBeNull();
  });

  it('returns low for low', () => {
    expect(oauthEpisodeConfidence('low')).toBe('low');
  });

  it('returns high for high — displayed as calibrated in UI', () => {
    expect(oauthEpisodeConfidence('high')).toBe('high');
  });
});
