import { describe, expect, it } from 'bun:test';
import { missionLayoutHref, parseMissionLayout } from './mission-layout';

describe('parseMissionLayout', () => {
  it('defaults to the Board', () => {
    expect(parseMissionLayout(undefined)).toBe('board');
    expect(parseMissionLayout('nonsense')).toBe('board');
  });

  it('reads a named layout', () => {
    expect(parseMissionLayout('lanes')).toBe('lanes');
    expect(parseMissionLayout('feed')).toBe('feed');
  });

  it('a Timeline/Structure link still opens the Feed it pointed into', () => {
    expect(parseMissionLayout(undefined, 'timeline')).toBe('feed');
    expect(parseMissionLayout(undefined, 'structure')).toBe('feed');
    expect(parseMissionLayout('lanes', 'timeline')).toBe('lanes');
  });
});

describe('missionLayoutHref', () => {
  it('keeps other params and drops layout for the Board', () => {
    expect(missionLayoutHref('/app/missions/m?from=home&layout=lanes', 'board')).toBe('/app/missions/m?from=home');
    expect(missionLayoutHref('/app/missions/m?from=home', 'lanes')).toBe('/app/missions/m?from=home&layout=lanes');
  });

  it('drops the Feed-only view param when leaving the Feed', () => {
    expect(missionLayoutHref('/app/missions/m?layout=feed&view=timeline', 'lanes')).toBe('/app/missions/m?layout=lanes');
    expect(missionLayoutHref('/app/missions/m?view=timeline', 'feed')).toBe('/app/missions/m?view=timeline&layout=feed');
  });
});
