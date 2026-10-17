import { describe, expect, it } from 'bun:test';
import {
  SPEC_AREA_STAY_MS, SPEC_STOOD_MS, gradeAreaFiling, gradeDuplicateDecision, specAreaObjective, specDuplicateObjective,
  type AreaGoldInput, type DuplicateGoldInput,
} from './spec-decision-gold';

const t0 = new Date('2026-09-01T00:00:00Z');
const after = (ms: number) => new Date(t0.getTime() + ms);

const dup = (o: Partial<DuplicateGoldInput> = {}): DuplicateGoldInput => ({
  verdict: 'duplicate', decidedAt: t0, now: after(1000), override: null, newSpec: { id: 'new', createdAt: after(5000) },
  newSpecSupersededBy: null, namedSupersededBy: null, ...o,
});

describe('duplicate check gold', () => {
  it('a refused duplicate the author superseded is right, one overridden as distinct is wrong', () => {
    expect(gradeDuplicateDecision(dup({ override: 'duplicate_superseded' }))).toMatchObject({ status: 'labelled', label: 'superseded' });
    expect(gradeDuplicateDecision(dup({ override: 'distinct' }))).toMatchObject({ status: 'labelled', label: 'distinct_override' });
    expect(gradeDuplicateDecision(dup({ override: 'superseded_other' }))).toMatchObject({ label: 'superseded_other' });
  });

  it('a warned duplicate is right once the named spec is superseded by the new one, and unknown before', () => {
    expect(gradeDuplicateDecision(dup({ namedSupersededBy: { id: 'new', at: after(9000) } }))).toMatchObject({ label: 'superseded', observedAt: after(9000) });
    expect(gradeDuplicateDecision(dup({ namedSupersededBy: { id: 'someone-else', at: after(9000) } }))).toEqual({ status: 'unknown', reason: 'open' });
    expect(gradeDuplicateDecision(dup())).toEqual({ status: 'unknown', reason: 'open' });
    expect(gradeDuplicateDecision(dup({ newSpec: null }))).toEqual({ status: 'unknown', reason: 'no_spec' });
  });

  it('a distinct verdict is wrong when an existing spec later replaced the new one', () => {
    const g = gradeDuplicateDecision(dup({ verdict: 'distinct', newSpecSupersededBy: { id: 'old', createdAt: after(-1000), at: after(7000) } }));
    expect(g).toMatchObject({ status: 'labelled', label: 'superseded_later', observedAt: after(7000) });
  });

  it('a distinct verdict replaced by a spec written after it says nothing, and never reads as stood', () => {
    const g = gradeDuplicateDecision(dup({ verdict: 'distinct', now: after(SPEC_STOOD_MS * 2), newSpecSupersededBy: { id: 'later', createdAt: after(9000), at: after(9500) } }));
    expect(g).toEqual({ status: 'unknown', reason: 'not_scored' });
  });

  it('a distinct verdict stood once the new spec went unreplaced long enough, not before', () => {
    expect(gradeDuplicateDecision(dup({ verdict: 'distinct', now: after(5000 + SPEC_STOOD_MS - 1) }))).toEqual({ status: 'unknown', reason: 'open' });
    expect(gradeDuplicateDecision(dup({ verdict: 'distinct', now: after(5000 + SPEC_STOOD_MS) }))).toMatchObject({ label: 'stood' });
  });

  it('never labels an overlap or a missing answer', () => {
    expect(gradeDuplicateDecision(dup({ verdict: 'overlap', override: 'distinct' }))).toEqual({ status: 'unknown', reason: 'not_scored' });
    expect(gradeDuplicateDecision(dup({ verdict: null }))).toEqual({ status: 'unknown', reason: 'not_scored' });
  });

  it('the objective scores each answer against its own labels', () => {
    const s = (label: string, answer: string) => specDuplicateObjective.score({ label, value: null }, answer);
    expect(s('superseded', 'duplicate')).toBe(true);
    expect(s('distinct_override', 'duplicate')).toBe(false);
    expect(s('superseded_other', 'duplicate')).toBeNull();
    expect(s('stood', 'distinct')).toBe(true);
    expect(s('superseded_later', 'distinct')).toBe(false);
    expect(s('stood', 'duplicate')).toBeNull();
    expect(s('superseded', 'overlap')).toBeNull();
    expect(specDuplicateObjective.source).toBe('spec_duplicate_followup');
  });
});

const area = (o: Partial<AreaGoldInput> = {}): AreaGoldInput => ({
  kind: 'filed', status: 'applied', createdAt: t0, resolvedAt: null, now: after(1000), filedParentId: 'a', currentParentId: 'a', ...o,
});

describe('area filing gold', () => {
  it('a filing a person moved or undid is wrong, at the time they did', () => {
    expect(gradeAreaFiling(area({ status: 'overridden', resolvedAt: after(500) }))).toMatchObject({ label: 'moved', observedAt: after(500) });
    expect(gradeAreaFiling(area({ status: 'undone', resolvedAt: after(600) }))).toMatchObject({ label: 'moved' });
  });

  it('a filing that stayed put past the window is right, not before', () => {
    expect(gradeAreaFiling(area({ now: after(SPEC_AREA_STAY_MS - 1) }))).toEqual({ status: 'unknown', reason: 'open' });
    expect(gradeAreaFiling(area({ now: after(SPEC_AREA_STAY_MS) }))).toMatchObject({ label: 'stayed' });
  });

  it('a spec that sits elsewhere with no filing row saying so is unknown, not right', () => {
    expect(gradeAreaFiling(area({ now: after(SPEC_AREA_STAY_MS * 2), currentParentId: 'b' }))).toEqual({ status: 'unknown', reason: 'changed_unrecorded' });
  });

  it('an accepted suggestion is right; a dismissed or open one is not scored', () => {
    expect(gradeAreaFiling(area({ kind: 'suggested', status: 'accepted', resolvedAt: after(10) }))).toMatchObject({ label: 'accepted' });
    expect(gradeAreaFiling(area({ kind: 'suggested', status: 'dismissed' }))).toEqual({ status: 'unknown', reason: 'not_scored' });
    expect(gradeAreaFiling(area({ kind: 'suggested', status: 'open' }))).toEqual({ status: 'unknown', reason: 'open' });
  });

  it('the objective scores area slots only', () => {
    const s = (label: string, answer: string) => specAreaObjective.score({ label, value: null }, answer);
    expect(s('stayed', 'area_3')).toBe(true);
    expect(s('accepted', 'area_1')).toBe(true);
    expect(s('moved', 'area_3')).toBe(false);
    expect(s('stayed', 'new_area')).toBeNull();
    expect(s('moved', 'unsure')).toBeNull();
    expect(specAreaObjective.source).toBe('spec_area_followup');
  });
});
