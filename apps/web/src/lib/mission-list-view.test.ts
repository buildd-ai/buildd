import { describe, expect, it } from 'bun:test';
import { parseMissionListView } from './mission-list-view';

describe('parseMissionListView', () => {
  it('reads ?view=structure and defaults everything else to the timeline', () => {
    expect(parseMissionListView('structure')).toBe('structure');
    expect(parseMissionListView('timeline')).toBe('timeline');
    expect(parseMissionListView('summary')).toBe('timeline');
    expect(parseMissionListView(undefined)).toBe('timeline');
  });
});
