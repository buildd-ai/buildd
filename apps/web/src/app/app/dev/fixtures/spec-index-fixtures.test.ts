import { describe, expect, it } from 'bun:test';
import { neighbourGraph, specIndexView } from '@/lib/specs/index-view';
import {
  SPEC_INDEX_FIXTURE_SPECS, SPEC_INDEX_GRAPH_FIXTURE, SPEC_INDEX_NO_AREA_FIXTURE, SPEC_INDEX_ONE_AREA_FIXTURE,
} from './spec-index-fixtures';

/** The `?state=spec-index` fixture covers every state §19 draws, so a Visual QA shot of it is a shot of each. */
describe('spec index fixture', () => {
  it('holds about 30 specs in five areas, with Unfiled, a possible area and every mix state', () => {
    const v = specIndexView(SPEC_INDEX_FIXTURE_SPECS);
    expect(v.total).toBeGreaterThanOrEqual(25);
    expect(v.total).toBeLessThanOrEqual(35);
    expect(v.areaCount).toBe(5);
    expect(v.possible.map((p) => p.title)).toEqual(['Notifications']);
    expect(v.loose.length).toBeGreaterThan(0);
    expect(v.waiting.length).toBeGreaterThan(0);
    const states = new Set(v.areas.flatMap((a) => Object.entries(a.mix).filter(([, n]) => n > 0).map(([s]) => s)));
    expect([...states].sort()).toEqual(['approved', 'draft', 'failing', 'imported']);
    expect(v.unfiled.some((u) => u.suggestion?.kind === 'parent')).toBe(true);
  });

  it('says its counts in one line with one area and with none', () => {
    expect(specIndexView(SPEC_INDEX_ONE_AREA_FIXTURE).areaCount).toBe(1);
    expect(specIndexView(SPEC_INDEX_NO_AREA_FIXTURE).line.text).toBe('12 specs, none filed yet');
  });

  it('graph fixture caps neighbours at 8', () => {
    const g = neighbourGraph(SPEC_INDEX_GRAPH_FIXTURE);
    expect(g.neighbours).toHaveLength(8);
    expect(g.omittedNeighbours).toBe(2);
    expect(g.siblings).toHaveLength(2);
  });
});
