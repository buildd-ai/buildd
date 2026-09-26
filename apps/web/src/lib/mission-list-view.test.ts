import { describe, expect, it } from 'bun:test';
import { parseMissionListView, missionListViewOpensDisclosure } from './mission-list-view';

describe('parseMissionListView', () => {
  it('reads ?view=structure and defaults everything else to the timeline', () => {
    expect(parseMissionListView('structure')).toBe('structure');
    expect(parseMissionListView('timeline')).toBe('timeline');
    expect(parseMissionListView('summary')).toBe('timeline');
    expect(parseMissionListView(undefined)).toBe('timeline');
  });
});

describe('missionListViewOpensDisclosure', () => {
  it('opens the Timeline · Structure disclosure when the URL names the structure view', () => {
    expect(missionListViewOpensDisclosure('structure')).toBe(true);
  });

  it('keeps it closed for the default timeline and anything unrecognised', () => {
    expect(missionListViewOpensDisclosure(undefined)).toBe(false);
    expect(missionListViewOpensDisclosure(null)).toBe(false);
    expect(missionListViewOpensDisclosure('timeline')).toBe(false);
    expect(missionListViewOpensDisclosure('summary')).toBe(false);
  });
});
