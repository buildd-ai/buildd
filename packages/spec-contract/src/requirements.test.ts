import { describe, expect, it } from 'bun:test';
import { criterionIdProblems, requirementIds, specCriteria } from './requirements';

describe('requirementIds', () => {
  it('finds ids in the forms specs use, first definition wins, fenced code ignored', () => {
    const body = [
      '# Checkout',
      'R-1: Totals are shown in the shopper\'s currency.',
      '- **AC-1** Given EUR, the total reads €.',
      '### D-2 Rates are cached for 15 minutes',
      '1. I-1. A rate is never older than an hour.',
      'R-1: a duplicate, ignored',
      '```', 'R-9: inside code', '```',
      'This mentions R-3 mid-sentence and is not a definition.',
    ].join('\n');
    expect(requirementIds(body).map((r) => [r.id, r.kind, r.line])).toEqual([
      ['R-1', 'requirement', 2], ['AC-1', 'acceptance', 3], ['D-2', 'decision', 4], ['I-1', 'invariant', 5],
    ]);
    expect(requirementIds(body)[1].text).toBe('Given EUR, the total reads €.');
  });
});

describe('specCriteria', () => {
  it('is the requirements and acceptance criteria only: decisions and invariants are context', () => {
    const body = ['R-1: a', '- AC-2: b', '### D-1 c', 'I-1: d', 'R-2: e'].join('\n');
    expect(specCriteria(body).map((r) => r.id)).toEqual(['R-1', 'AC-2', 'R-2']);
    expect(specCriteria('# No ids here\nJust prose.')).toEqual([]);
  });
});

describe('criteria in a table', () => {
  const body = [
    '| ID | Requirement | Check |',
    '|----|-------------|-------|',
    '| **R-1** | Totals are in the shopper\'s currency. | unit |',
    '| AC-2 | Empty cart: show \\| hide | |',
    '| R-3 is here | not an id cell | x |',
    '- **R-1** a repeat, the table row wins',
    '```',
    '| AC-9 | fenced, ignored |',
    '```',
    '- AC-4: a list item still works',
  ].join('\n');
  it('a row whose first cell is an id defines it, with the other cells as its text', () => {
    expect(requirementIds(body).map((r) => [r.id, r.text])).toEqual([
      ['R-1', "Totals are in the shopper's currency.; unit"],
      ['AC-2', 'Empty cart: show | hide'],
      ['AC-4', 'a list item still works'],
    ]);
    expect(specCriteria(body).map((r) => r.id)).toEqual(['R-1', 'AC-2', 'AC-4']);
  });
  it('a body with no table parses exactly as before', () => {
    expect(requirementIds('- **R-1** One.\n### D-2 Two\n').map((r) => r.id)).toEqual(['R-1', 'D-2']);
  });
});


describe('criterionIdProblems: ids a reader would take for criteria that the parser does not read', () => {
  const body = [
    '# Spec',
    '- AC-1: plain, read.',
    '- AC-3a: a letter suffix.',
    '- **AC-AQR-1** a prefix.',
    'INV-2: an invariant spelled INV.',
    '### R-CG-4 a prefixed heading',
    '| AC-7b | a suffixed table row |',
    '- AC-1: defined again.',
    '| AC-1 | and a third time, in a table |',
    '- R-2: once.',
    '```', '- AC-9z: inside code', '- R-2: inside code', '```',
    'Prose that mentions AC-3a mid-sentence is not a definition.',
  ].join('\n');

  it('lists the letter-suffixed, prefixed and INV ids at a definition position, with their lines', () => {
    expect(criterionIdProblems(body).unreadable).toEqual([
      { id: 'AC-3a', line: 3 },
      { id: 'AC-AQR-1', line: 4 },
      { id: 'INV-2', line: 5 },
      { id: 'R-CG-4', line: 6 },
      { id: 'AC-7b', line: 7 },
    ]);
  });

  it('lists ids defined more than once, with every line that defines them', () => {
    expect(criterionIdProblems(body).duplicates).toEqual([{ id: 'AC-1', lines: [2, 8, 9] }]);
  });

  it('does not read a letter-suffixed id as the plain one (AC-3a is not AC-3)', () => {
    expect(requirementIds(body).map((r) => r.id)).toEqual(['AC-1', 'R-2']);
  });

  it('a clean body has no problems', () => {
    expect(criterionIdProblems('- R-1: one\n- AC-1: two\n| D-1 | three |')).toEqual({ unreadable: [], duplicates: [] });
  });
});
