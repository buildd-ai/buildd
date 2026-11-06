/**
 * Explanation checked when written (Living Spec b7fc9316 R-28, R-29, AC-29,
 * AC-30): the pure half. An agent's revise is measured approved revision to
 * new head with the same explanationCoverage the approval page uses. The
 * wiring (who is exempt, nothing written) is tested in store and over MCP.
 */
import { describe, expect, it } from 'bun:test';
import { explanationRefusalText } from './explanation-check';

const body = (o: { r1?: string; r2?: string; r3?: string; ctx?: string; ac?: string }) => [
  '# Checkout', '', '## Context', '', o.ctx ?? 'Totals are shown before paying.', '',
  '## Requirements', '', `- R-1: ${o.r1 ?? 'Totals are exact.'}`, `- R-2: ${o.r2 ?? 'Totals are in the shopper currency.'}`,
  ...(o.r3 ? [`- R-3: ${o.r3}`] : []), `- AC-1: ${o.ac ?? 'GIVEN a cart THEN the total shows.'}`, '',
].join('\n');

describe('explanationRefusalText', () => {
  it('AC-29: a criterion and a section left out are named, and nothing else', () => {
    const approved = body({});
    const next = body({ r1: 'Totals round to cents.', ctx: 'Totals show with tax.' });
    const msg = explanationRefusalText(approved, next, { summary: 's', lines: {} });
    expect(msg).toContain('R-1');
    expect(msg).toContain('Context');
    expect(msg).not.toContain('R-2');
    expect(msg).toContain('Nothing was written');
  });

  it('AC-29: adding those lines passes', () => {
    const next = body({ r1: 'Totals round to cents.', ctx: 'Totals show with tax.' });
    expect(explanationRefusalText(body({}), next, { summary: 's', lines: { 'R-1': 'Rounds.', Context: 'Tax.' } })).toBeNull();
  });

  it('no explanation at all is refused when something changed', () => {
    expect(explanationRefusalText(body({}), body({ r1: 'x' }), null)).toContain('R-1');
  });

  it('nothing changed since the approved revision: nothing to cover', () => {
    expect(explanationRefusalText(body({}), body({}), null)).toBeNull();
  });

  it('a spec with no approved revision is measured against nothing (R-28)', () => {
    expect(explanationRefusalText(null, body({ r1: 'x' }), null)).toBeNull();
  });

  it('stacked: r3 and r4 unapproved, an r5 explanation covering only its own change is refused', () => {
    const approved = body({});                                   // r2, approved
    const r5 = body({ r1: 'Totals round to cents.', r2: 'Never converted.', r3: 'Tax is shown.' }); // r3 changed R-1, r4 R-2, r5 adds R-3
    const msg = explanationRefusalText(approved, r5, { summary: 's', lines: { 'R-3': 'Adds tax.' } });
    expect(msg).toContain('R-1');
    expect(msg).toContain('R-2');
    expect(msg).not.toContain('R-3,');
    expect(explanationRefusalText(approved, r5, { summary: 's', lines: { 'R-1': 'a', 'R-2': 'b', 'R-3': 'c' } })).toBeNull();
  });
});
