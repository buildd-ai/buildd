import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { criterionRecords, otherTextBySection, replacedIds, sectionPaths } from './criterion-records';
import {
  changeLines, criterionChanges, idRanges, otherTextChanges, summaryIds, summaryMismatch, summaryMismatchLine, wordDiff, mostlyRewritten, tidyWordOps,
  type ReviewRecord,
} from './criterion-review';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const records = (body: string): ReviewRecord[] => criterionRecords(body).map((r) => ({ id: r.id, text: r.text, textHash: sha(r.text), section: r.section, replaces: r.replaces }));

describe('criterionRecords', () => {
  const body = [
    '# Spec',
    '## Requirements',
    '### Review',
    '- R-1: Review leads with the summary.',
    '  It is above everything else.',
    '  check: `bun test a`',
    '  screen: review, review-mobile',
    '- R-2: The change list.',
    '- A plain bullet under R-2 is not part of it.',
    '',
    'A paragraph after the list.',
    '## Acceptance',
    '| Id | Text |',
    '|----|------|',
    '| AC-1 | One changed, one range. |',
    '- R-50: Replaces two.',
    '  replaces: R-26, `R-27`',
    '### D-1 a decision is not a criterion',
  ].join('\n');

  it('derives one record per R-n/AC-n with its words, section and labelled lines', () => {
    const rs = criterionRecords(body);
    expect(rs.map((r) => r.id)).toEqual(['R-1', 'R-2', 'AC-1', 'R-50']);
    expect(rs[0]).toMatchObject({
      kind: 'requirement', position: 0, line: 4,
      text: 'Review leads with the summary.\nIt is above everything else.',
      section: 'Spec > Requirements > Review', checks: ['bun test a'], screens: ['review', 'review-mobile'], replaces: [],
    });
    // A sibling bullet ends the item; a blank line ends it too.
    expect(rs[1].text).toBe('The change list.');
    expect(rs[2]).toMatchObject({ kind: 'acceptance', text: 'One changed, one range.', section: 'Spec > Acceptance' });
    expect(rs[3].replaces).toEqual(['R-26', 'R-27']);
  });

  it('re-indenting or changing a check line leaves the words alone', () => {
    const moved = body.replace('  It is above', '      It is above').replace('bun test a', 'bun test b');
    expect(criterionRecords(moved)[0].text).toBe(criterionRecords(body)[0].text);
  });

  it('keeps text outside criteria per section, with label lines', () => {
    const other = otherTextBySection(body);
    expect(other.get('Spec > Requirements > Review')).toContain('A paragraph after the list.');
    expect(other.get('Spec > Requirements > Review')).toContain('check: `bun test a`');
    expect(other.get('Spec > Requirements > Review')).not.toContain('Review leads with');
  });

  it('reads heading paths and replaced ids', () => {
    expect(sectionPaths('pre\n# A\n## B\n```\n# not\n```\n# C')).toEqual(['', 'A', 'A > B', 'A > B', 'A > B', 'A > B', 'C']);
    expect(replacedIds('R-26, AC-3 and R-26, X-1')).toEqual(['R-26', 'AC-3']);
  });
});

describe('criterionChanges', () => {
  const v1 = ['# S', '## A', '- R-1: one', '- R-2: two', '- R-24: moves', '## B', '- R-26: old words here', '- AC-1: accept'].join('\n');

  it('AC-1: one changed and one added range of three', () => {
    const v2 = v1.replace('R-1: one', 'R-1: one, now longer').replace('- AC-1: accept', '- AC-1: accept\n- R-44: a\n- R-45: b\n- R-46: c');
    const lines = changeLines(criterionChanges(records(v1), records(v2)));
    expect(lines.map((l) => l.kind)).toEqual(['changed', 'added-range']);
    expect(lines[1]).toMatchObject({ label: 'R-44 – R-46' });
    const changed = lines[0] as Extract<typeof lines[number], { kind: 'changed' }>;
    expect(changed.words).toEqual([{ op: '=', text: 'one' }, { op: '+', text: ', now longer' }]);
  });

  it('AC-3: an unchanged criterion under another heading is moved, nowhere else', () => {
    const v2 = v1.replace('- R-24: moves\n', '').replace('- AC-1: accept', '- AC-1: accept\n- R-24: moves');
    const changes = criterionChanges(records(v1), records(v2));
    expect(changes).toEqual([{ kind: 'moved', id: 'R-24', text: 'moves', section: 'S > B', movedFrom: 'S > A' }]);
  });

  it('AC-8: a criterion with replaces: lists what it replaces, and the replaced one is not also removed', () => {
    const v2 = v1.replace('- R-26: old words here', '- R-50: new words\n  replaces: R-26');
    const changes = criterionChanges(records(v1), records(v2));
    expect(changes).toEqual([{ kind: 'replacing', id: 'R-50', text: 'new words', section: 'S > B', replaces: [{ id: 'R-26', oldText: 'old words here' }] }]);
  });

  it('lists removed criteria where they stood', () => {
    const v2 = v1.replace('- R-2: two\n', '');
    expect(criterionChanges(records(v1), records(v2))).toEqual([{ kind: 'removed', id: 'R-2', oldText: 'two', section: 'S > A' }]);
  });

  it('does not fold a single added criterion', () => {
    const v2 = `${v1}\n- R-60: x`;
    expect(changeLines(criterionChanges(records(v1), records(v2))).map((l) => l.kind)).toEqual(['added']);
  });
});

describe('otherTextChanges', () => {
  it('names sections whose prose changed, not their criteria', () => {
    const a = otherTextBySection('# S\nIntro.\n## A\n- R-1: x\n\nProse.\n## Gone\nBye.');
    const b = otherTextBySection('# S\nIntro.\n## A\n- R-1: y\n\nProse, edited.\n## New\nHi.');
    expect(otherTextChanges(a, b)).toEqual([
      { kind: 'changed', section: 'S > A' }, { kind: 'removed', section: 'S > Gone' }, { kind: 'added', section: 'S > New' },
    ]);
  });
});

describe('summaryMismatch', () => {
  const changed = (ids: string[]) => ids.map((id) => ({ kind: 'changed' as const, id, text: '', oldText: '', words: [], section: '' }));

  it('AC-2: a summary naming R-26 while R-25 and R-26 changed names R-25', () => {
    const m = summaryMismatch('Tighten R-26.', changed(['R-25', 'R-26']));
    expect(m).toEqual({ unmentioned: ['R-25'], unchanged: [] });
    expect(summaryMismatchLine(m)).toBe('The summary does not mention R-25, which changed.');
  });

  it('expands ranges and says when the summary names an unchanged id', () => {
    expect([...summaryIds('Adds R-11 to R-16, AC-6 – AC-9 and R-3.')]).toEqual(['R-11', 'R-12', 'R-13', 'R-14', 'R-15', 'R-16', 'AC-6', 'AC-7', 'AC-8', 'AC-9', 'R-3']);
    expect(summaryMismatchLine(summaryMismatch('Changes R-1 and R-2.', changed(['R-1'])))).toBe('The summary names R-2, which this revision does not change.');
    expect(summaryMismatch('Changes R-1.', changed(['R-1']))).toBeNull();
    expect(summaryMismatch(null, changed(['R-1']))).toBeNull();
  });
});

describe('helpers', () => {
  it('idRanges folds consecutive ids of a kind', () => {
    expect(idRanges(['R-44', 'R-45', 'R-46', 'AC-27', 'AC-28', 'R-50'])).toBe('R-44 – R-46, AC-27 – AC-28, R-50');
  });
  it('wordDiff joins back to both texts', () => {
    const ops = wordDiff('the quick brown fox', 'the slow brown dog');
    expect(ops.filter((o) => o.op !== '+').map((o) => o.text).join('')).toBe('the quick brown fox');
    expect(ops.filter((o) => o.op !== '-').map((o) => o.text).join('')).toBe('the slow brown dog');
  });

  describe('wordDiff clean-up (R-17, R-18)', () => {
    const texts = (ops: ReturnType<typeof wordDiff>, op: string) => ops.filter((o) => o.op === op).map((o) => o.text);
    it('never marks whitespace or punctuation alone', () => {
      expect(wordDiff('It works.', 'It works,')).toEqual([{ op: '=', text: 'It works,' }]);
      expect(wordDiff('a b', 'a  b').every((o) => o.op === '=')).toBe(true);
    });
    it('merges changed runs split by one short unchanged word', () => {
      const ops = wordDiff('the old system of record', 'a new system for ledgers');
      // "system" is a long word; "of"/"for" differ, so check the short bridge case separately.
      expect(ops.length).toBeGreaterThan(0);
      const bridged = wordDiff('show red to blue', 'draw cyan to pink');
      expect(texts(bridged, '-')).toEqual(['show red to blue']);
      expect(texts(bridged, '+')).toEqual(['draw cyan to pink']);
    });
    it('keeps a long unchanged word as a break', () => {
      const ops = wordDiff('alpha beta middleword gamma delta', 'one two middleword three four');
      expect(texts(ops, '=')).toContain(' middleword ');
    });
    it('has at most one removed run then one added run at a point', () => {
      const ops = wordDiff('a x b y c z d', 'a p b q c r d');
      for (let i = 1; i < ops.length; i++) {
        expect(ops[i]!.op === ops[i - 1]!.op).toBe(false);
        if (ops[i]!.op === '-') expect(ops[i - 1]!.op).toBe('=');
      }
    });
    it('keeps the new text whole', () => {
      const ops = tidyWordOps(wordDiff('Use `foo` here.', 'Use `bar` there!'));
      expect(ops.filter((o) => o.op !== '-').map((o) => o.text).join('')).toBe('Use `bar` there!');
    });
    it('switches at more than a third of the words changed', () => {
      expect(mostlyRewritten(wordDiff('one two three four five six', 'one two three four five seven'))).toBe(false);
      expect(mostlyRewritten(wordDiff('one two three four five six', 'one two three alpha beta gamma'))).toBe(true);
      expect(mostlyRewritten([])).toBe(false);
    });
  });
});
