import { describe, expect, it } from 'bun:test';
import { pickShownTeam } from './shown-team';

// Illustrative fixtures only.
const a = { id: 'team-a', name: 'Alpha' };
const b = { id: 'team-b', name: 'Beta' };

describe('pickShownTeam', () => {
  it('shows the active team without ?team', () => {
    expect(pickShownTeam([a, b], undefined, a)).toBe(a);
  });

  it('shows another of the person\'s teams when ?team names it', () => {
    expect(pickShownTeam([a, b], 'team-b', a)).toBe(b);
    expect(pickShownTeam([a, b], ['team-b', 'team-a'], a)).toBe(b);
  });

  it('falls back to the active team for a team they are not in', () => {
    expect(pickShownTeam([a, b], 'team-z', a)).toBe(a);
  });

  it('is null with no team at all', () => {
    expect(pickShownTeam([], 'team-a', null)).toBeNull();
  });
});
