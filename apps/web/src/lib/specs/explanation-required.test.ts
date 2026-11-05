import { describe, expect, it } from 'bun:test';
import { explanationRefusal } from './explanation-required';

const V1 = ['# Checkout', '', '## Context', '', 'Totals shown.', '', '## Requirements', '', '- R-1: Totals are exact.', '- R-2: Tax is shown.', ''].join('\n');
const V2 = ['# Checkout', '', '## Context', '', 'Totals shown before paying.', '', '## Requirements', '', '- R-1: Totals round to cents.', '- R-2: Tax is shown.', '- R-3: Refunds are listed.', ''].join('\n');
const ex = (lines: Record<string, string>) => ({ summary: 's', lines });

describe('explanationRefusal (agent revisions must explain every change)', () => {
  it('names every unexplained criterion and section', () => {
    const r = explanationRefusal(V1, V2, null);
    expect(r).not.toBeNull();
    expect(r!.missing).toEqual(expect.arrayContaining(['R-1', 'R-3', 'Checkout > Context']));
    expect(r!.message).toContain('R-1');
    expect(r!.message).toContain('Checkout > Context');
  });

  it('names only what is left out of a partial explanation', () => {
    const r = explanationRefusal(V1, V2, ex({ 'R-1': 'rounds', 'Checkout > Context': 'wording' }));
    expect(r!.missing).toEqual(['R-3']);
  });

  it('passes when every change is explained', () => {
    expect(explanationRefusal(V1, V2, ex({ 'R-1': 'a', 'R-3': 'b', 'Checkout > Context': 'c' }))).toBeNull();
  });

  it('passes when nothing changed', () => {
    expect(explanationRefusal(V1, V1, null)).toBeNull();
  });
});
