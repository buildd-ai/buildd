/**
 * Living Specs Slice 13, R-63 / AC-46 / AC-48: delivery and current standing
 * are said apart, work built to an older revision never reads as proof of the
 * one in force, stale / failing / waived never read as passed, and the words
 * are only the ones the task page already uses.
 */
import { describe, expect, it } from 'bun:test';
import { criterionWords, deliveredSentence, markOf, standingSentence, type CriterionMark } from './delivery-words';

const crit = (...marks: CriterionMark[]) => marks.map((mark, i) => ({ criterionId: `AC-${i + 1}`, mark }));

describe('standingSentence', () => {
  it('AC-46: verified on revision 2 reads not verified yet once revision 3 is approved', () => {
    const s = standingSentence({ builtTo: 2, approved: 3, outcome: 'verified', criteria: crit('pass', 'pass') });
    expect(s).toEqual({ tone: 'muted', text: 'Not verified yet against revision 3.' });
  });

  it('verified on the revision in force reads verified', () => {
    expect(standingSentence({ builtTo: 3, approved: 3, outcome: 'verified', criteria: crit('pass') }))
      .toEqual({ tone: 'success', text: 'Verified against revision 3.' });
  });

  it('a fail names the failing criteria and never reads as passed', () => {
    const s = standingSentence({ builtTo: 3, approved: 3, outcome: 'fail', criteria: crit('pass', 'fail') });
    expect(s.tone).toBe('error');
    expect(s.text).toBe('AC-2 fails against revision 3.');
  });

  it('a pass on an older commit reads not verified yet, never verified', () => {
    const s = standingSentence({ builtTo: 3, approved: 3, outcome: 'unverified', criteria: crit('stale', 'pass') });
    expect(s).toEqual({ tone: 'muted', text: 'Passed on an older commit. Not verified yet against revision 3.' });
  });

  it('verdict-less work reads not verified yet', () => {
    expect(standingSentence({ builtTo: 1, approved: 1, outcome: 'unverified', criteria: crit('none') }).text)
      .toBe('Not verified yet against revision 1.');
  });

  it('a waived criterion is said as waived, by whom, and the rest still has to pass', () => {
    const s = standingSentence({
      builtTo: 2, approved: 2, outcome: 'unverified', criteria: crit('none', 'waived'),
      waivedBy: [{ criterionId: 'AC-2', by: 'Max' }],
    });
    expect(s.tone).toBe('muted');
    expect(s.text).toBe('Not verified yet against revision 2. AC-2 waived by Max.');
  });

  it('with nothing approved, the standing is against the revision it was built to', () => {
    expect(standingSentence({ builtTo: 1, approved: null, outcome: 'unverified', criteria: crit('none') }).text)
      .toBe('Not verified yet against revision 1.');
  });
});

describe('deliveredSentence', () => {
  it('says the revision and whether it shipped, and nothing about a verdict', () => {
    expect(deliveredSentence({ builtTo: 2, provisional: false, delivered: true })).toBe('Built to revision 2 and delivered.');
    expect(deliveredSentence({ builtTo: 2, provisional: false, delivered: false })).toBe('Built to revision 2, not delivered yet.');
    expect(deliveredSentence({ builtTo: 4, provisional: true, delivered: false })).toBe('Built to revision 4 ahead of its approval, not delivered yet.');
  });
});

describe('words', () => {
  it('AC-48: only the task page\'s words, plus waived; no em dash', () => {
    const marks: CriterionMark[] = ['pass', 'fail', 'stale', 'none', 'inconclusive', 'unsupported', 'waived'];
    expect(marks.map((m) => criterionWords(m).label)).toEqual([
      'Passes', 'Fails', 'Passed on an older commit', 'No verdict', 'Inconclusive', 'Unsupported', 'Waived',
    ]);
    const all = [
      ...marks.map((m) => criterionWords(m).label),
      standingSentence({ builtTo: 2, approved: 3, outcome: 'verified', criteria: [] }).text,
      deliveredSentence({ builtTo: 2, provisional: true, delivered: true }),
    ].join(' ');
    expect(all).not.toContain('—');
  });

  it('a stale pass is not a pass; a stale fail is still a fail', () => {
    expect(markOf({ verdict: 'pass', stale: true })).toBe('stale');
    expect(markOf({ verdict: 'pass', stale: false })).toBe('pass');
    expect(markOf({ verdict: 'fail', stale: true })).toBe('fail');
    expect(markOf({ verdict: null, stale: false })).toBe('none');
  });
});
