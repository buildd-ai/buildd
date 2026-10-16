import { describe, expect, test } from 'bun:test';
import { criterionTexts, specSourceLine, withSpecSourceBlock } from './provisional-text';

const LEDE = '<!-- buildd-lede -->\nA lede.\n<!-- /buildd-lede -->';

describe('PR text for work built ahead of approval (R-38, R-41)', () => {
  test('a provisional pin says what it was built against, and nothing about a contradiction', () => {
    const line = specSourceLine({ specId: 'x', revision: 3, provisional: true });
    expect(line).toContain('Built ahead of approval, against revision 3');
    expect(line).not.toMatch(/awaiting approval|draft/i);
  });

  test('a re-graded pin names the revision it was built against and the approved one', () => {
    expect(specSourceLine({ specId: 'x', revision: 4, regradedFrom: { revision: 3 } }))
      .toContain('Built ahead of approval against revision 3, re-graded against approved revision 4');
  });

  test('an ordinary pin or no pin adds nothing', () => {
    expect(specSourceLine({ specId: 'x', revision: 2 })).toBeNull();
    expect(specSourceLine(undefined)).toBeNull();
    expect(withSpecSourceBlock('Body.', { specId: 'x', revision: 2 })).toBe('Body.');
  });

  test('the block goes under the lede, and is replaced in place, never duplicated', () => {
    const first = withSpecSourceBlock(`${LEDE}\n\nBody.`, { specId: 'x', revision: 1, provisional: true });
    expect(first.indexOf('Built ahead of approval')).toBeGreaterThan(first.indexOf('<!-- /buildd-lede -->'));
    expect(first.indexOf('Built ahead of approval')).toBeLessThan(first.indexOf('Body.'));
    const second = withSpecSourceBlock(first, { specId: 'x', revision: 2, regradedFrom: { revision: 1 } });
    expect(second).toContain('re-graded against approved revision 2');
    expect(second).not.toContain('Built ahead of approval, against revision 1');
    expect(second.match(/buildd-spec-source -->/g)).toHaveLength(2);
    expect(second).toContain('Body.');
  });

  test('with no lede the block leads the body', () => {
    expect(withSpecSourceBlock('Body.', { specId: 'x', revision: 1, provisional: true })).toMatch(/^<!-- buildd-spec-source -->/);
  });
});

describe('criterion text for verdict carry-over (R-40)', () => {
  test('a criterion is its line and the lines under it, up to the next criterion or heading', () => {
    const body = '# A\nR-1: One.\n  check: `x`\nR-2: Two.\n\n## B\n- AC-1: Three.\n';
    const t = criterionTexts(body);
    expect(t.get('R-1')).toBe('R-1: One.\ncheck: `x`');
    expect(t.get('R-2')).toBe('R-2: Two.');
    expect(t.get('AC-1')).toBe('- AC-1: Three.');
  });

  test('a changed check line changes the text; indentation alone does not', () => {
    const a = criterionTexts('R-1: One.\n  check: `x`\n').get('R-1');
    expect(criterionTexts('R-1: One.\n    check: `x`\n').get('R-1')).toBe(a);
    expect(criterionTexts('R-1: One.\n  check: `y`\n').get('R-1')).not.toBe(a);
  });
});
