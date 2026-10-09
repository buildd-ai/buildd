import { describe, expect, it } from 'bun:test';
import { MISSION_LAYOUT_LABEL, MISSION_LAYOUT_TABS, missionLayoutHref, parseMissionLayout } from './mission-layout';

describe('parseMissionLayout', () => {
  it('defaults to the Board', () => {
    expect(parseMissionLayout(undefined)).toBe('board');
    expect(parseMissionLayout('nonsense')).toBe('board');
  });

  it('reads a named layout', () => {
    expect(parseMissionLayout('flow')).toBe('flow');
    expect(parseMissionLayout('feed')).toBe('feed');
  });

  it('Flow replaced Lanes and the Structure graph: their old links open Flow', () => {
    expect(parseMissionLayout('lanes')).toBe('flow');
    expect(parseMissionLayout(undefined, 'structure')).toBe('flow');
  });

  it('a Timeline link still opens History (the Feed) it pointed into', () => {
    expect(parseMissionLayout(undefined, 'timeline')).toBe('feed');
    expect(parseMissionLayout('flow', 'timeline')).toBe('flow');
  });

  it('the tabs are Overview · Flow · History: no Lanes or Structure tab, no Graph/Timeline toggle', () => {
    expect(MISSION_LAYOUT_TABS.map(l => MISSION_LAYOUT_LABEL[l])).toEqual(['Overview', 'Flow', 'History']);
  });
});

describe('missionLayoutHref', () => {
  it('keeps other params and drops layout for the Board', () => {
    expect(missionLayoutHref('/app/missions/m?from=home&layout=flow', 'board')).toBe('/app/missions/m?from=home');
    expect(missionLayoutHref('/app/missions/m?from=home', 'flow')).toBe('/app/missions/m?from=home&layout=flow');
  });

  it('drops the Feed-only view param when leaving the Feed', () => {
    expect(missionLayoutHref('/app/missions/m?layout=feed&view=timeline', 'flow')).toBe('/app/missions/m?layout=flow');
    expect(missionLayoutHref('/app/missions/m?view=timeline', 'feed')).toBe('/app/missions/m?view=timeline&layout=feed');
  });
});
