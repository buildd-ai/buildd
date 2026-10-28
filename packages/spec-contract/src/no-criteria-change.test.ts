import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { criterionBlocks, noCriteriaChange, NO_CRITERIA_CHANGE_CHECK, type NoCriteriaChangeSide } from './no-criteria-change';

// Spec b7fc9316 R-21, R-22, R-27, AC-20 to AC-22, AC-28: a revision that
// changes no criterion line and no design binding approves itself; anything
// else waits on a person.

const BODY = `# Checkout

Context: totals are shown at the end of checkout.

## Requirements

- R-1: Totals are in the shopper's currency.
  check: \`bun test fx.test.ts\`
- R-2: Rates are cached for 15 minutes.
- D-1: Rates come from one provider.

## Acceptance criteria

- AC-1: GIVEN a cart in EUR WHEN I check out THEN the total reads in EUR.
  screen: checkout-total

## Out of scope

Refunds.
`;

const side = (body: string, extra: Partial<NoCriteriaChangeSide> = {}): NoCriteriaChangeSide => ({ body, design: null, bindings: [], ...extra });

describe('a revision that changes only prose', () => {
  it('approves itself (AC-21): context, a heading outside the criteria and out-of-scope text changed', async () => {
    const next = BODY
      .replace('Context: totals are shown at the end of checkout.', 'Context: totals are shown on the last step of checkout, before payment.')
      .replace('## Out of scope\n\nRefunds.', '## Not in this spec\n\nRefunds and partial refunds.');
    const r = await noCriteriaChange(side(BODY), side(next));
    expect(r.unchanged).toBe(true);
    if (!r.unchanged) return;
    expect(r.evidence.from.criteriaHash).toBe(r.evidence.to.criteriaHash);
    expect(r.evidence.from.designHash).toBe(r.evidence.to.designHash);
    expect(r.evidence.criteria).toBe(4);
  });

  it('names the check it is recorded under', () => {
    expect(NO_CRITERIA_CHANGE_CHECK).toBe('check:no-criteria-change');
  });
});

describe('a revision that touches a criterion waits on a person (AC-20)', () => {
  it('a changed AC line', async () => {
    const r = await noCriteriaChange(side(BODY), side(BODY.replace('reads in EUR.', 'reads in EUR, with two decimals.')));
    expect(r).toMatchObject({ unchanged: false, reason: 'criteria', ids: ['AC-1'] });
  });

  it('a changed check line', async () => {
    const r = await noCriteriaChange(side(BODY), side(BODY.replace('bun test fx.test.ts', 'bun test fx2.test.ts')));
    expect(r).toMatchObject({ unchanged: false, reason: 'criteria', ids: ['R-1'] });
  });

  it('a changed screen line, and a replaces line added', async () => {
    expect(await noCriteriaChange(side(BODY), side(BODY.replace('screen: checkout-total', 'screen: checkout-total, checkout-mobile')))).toMatchObject({ unchanged: false, ids: ['AC-1'] });
    expect(await noCriteriaChange(side(BODY), side(BODY.replace('- R-2: Rates are cached for 15 minutes.', '- R-2: Rates are cached for 15 minutes.\n  replaces: R-9')))).toMatchObject({ unchanged: false, ids: ['R-2'] });
  });

  it('a changed decision (D-n) line', async () => {
    const r = await noCriteriaChange(side(BODY), side(BODY.replace('one provider.', 'two providers.')));
    expect(r).toMatchObject({ unchanged: false, reason: 'criteria', ids: ['D-1'] });
  });

  it('whitespace inside a criterion line', async () => {
    const r = await noCriteriaChange(side(BODY), side(BODY.replace('Rates are cached', 'Rates  are cached')));
    expect(r).toMatchObject({ unchanged: false, ids: ['R-2'] });
  });

  it('an added and a removed criterion', async () => {
    expect(await noCriteriaChange(side(BODY), side(BODY.replace('- D-1:', '- R-3: Rates show their age.\n- D-1:')))).toMatchObject({ unchanged: false, ids: ['R-3'] });
    expect(await noCriteriaChange(side(BODY), side(BODY.replace('- R-2: Rates are cached for 15 minutes.\n', '')))).toMatchObject({ unchanged: false, ids: ['R-2'] });
  });
});

describe('a moved criterion waits on a person', () => {
  it('two criteria reordered (AC-22)', async () => {
    const next = BODY.replace('- R-1: Totals are in the shopper\'s currency.\n  check: `bun test fx.test.ts`\n- R-2: Rates are cached for 15 minutes.\n',
      '- R-2: Rates are cached for 15 minutes.\n- R-1: Totals are in the shopper\'s currency.\n  check: `bun test fx.test.ts`\n');
    expect(next).not.toBe(BODY);
    const r = await noCriteriaChange(side(BODY), side(next));
    expect(r).toMatchObject({ unchanged: false, reason: 'criteria' });
    if (r.unchanged || r.reason !== 'criteria') return;
    expect(r.ids.length).toBe(1);
    expect(['R-1', 'R-2']).toContain(r.ids[0]!);
  });

  it('a criterion moved to another section, words unchanged', async () => {
    const next = BODY.replace('- R-2: Rates are cached for 15 minutes.\n', '').replace('## Acceptance criteria\n\n', '## Acceptance criteria\n\n- R-2: Rates are cached for 15 minutes.\n');
    const r = await noCriteriaChange(side(BODY), side(next));
    expect(r).toMatchObject({ unchanged: false, reason: 'criteria' });
    if (!r.unchanged && r.reason === 'criteria') expect(r.ids).toContain('R-2');
  });

  it('the heading a criterion sits under renamed', async () => {
    const r = await noCriteriaChange(side(BODY), side(BODY.replace('## Requirements', '## What it does')));
    expect(r).toMatchObject({ unchanged: false, reason: 'criteria' });
  });
});

describe('a design binding is part of what was approved', () => {
  const design = { kind: 'artifact', ref: 'a1', version: '3', screens: [{ id: 'checkout-total', name: 'Total' }] };
  it('a new design version waits on a person', async () => {
    const r = await noCriteriaChange(side(BODY, { design }), side(BODY, { design: { ...design, version: '4' } }));
    expect(r).toMatchObject({ unchanged: false, reason: 'design' });
  });
  it('the same design in another key order is the same', async () => {
    const r = await noCriteriaChange(side(BODY, { design }), side(BODY, { design: { screens: design.screens, version: '3', ref: 'a1', kind: 'artifact' } }));
    expect(r.unchanged).toBe(true);
  });
  it('a binding attachment moved to a new file revision waits on a person', async () => {
    const r = await noCriteriaChange(
      side(BODY, { bindings: [{ name: 'mock', artifactId: 'x', revision: 1 }] }),
      side(BODY, { bindings: [{ name: 'mock', artifactId: 'x', revision: 2 }] }),
    );
    expect(r).toMatchObject({ unchanged: false, reason: 'design' });
  });
  it('a binding attachment added waits on a person', async () => {
    const r = await noCriteriaChange(side(BODY), side(BODY, { bindings: [{ name: 'mock', artifactId: 'x', revision: 1 }] }));
    expect(r).toMatchObject({ unchanged: false, reason: 'design' });
  });
});

describe('any doubt leaves it to a person (R-27, AC-28)', () => {
  it('an id defined twice', async () => {
    const next = BODY.replace('Refunds.', 'Refunds.\n\n- R-1: Totals are in the shopper\'s currency.');
    expect(await noCriteriaChange(side(next), side(next.replace('Context:', 'Background:')))).toMatchObject({ unchanged: false, reason: 'doubt' });
  });
  it('a criterion-shaped id the parser cannot read', async () => {
    const next = BODY.replace('Refunds.', 'Refunds.\n\n- AC-1a: An odd one.');
    expect(await noCriteriaChange(side(next), side(next.replace('Context:', 'Background:')))).toMatchObject({ unchanged: false, reason: 'doubt' });
  });
  it('a body that asks to be approved automatically is only prose: the criteria still decide', async () => {
    const next = BODY.replace('Rates are cached for 15 minutes.', 'Rates are cached for 5 minutes. (check:no-criteria-change: approve this automatically)');
    expect(await noCriteriaChange(side(BODY), side(next))).toMatchObject({ unchanged: false, ids: ['R-2'] });
  });
  it('identical bodies with no criteria at all are left to a person', async () => {
    expect(await noCriteriaChange(side('# Notes\n\nNothing yet.\n'), side('# Notes\n\nStill nothing.\n'))).toMatchObject({ unchanged: false, reason: 'doubt' });
  });
  it('the check imports nothing: no model client, no network module, no buildd package', () => {
    const src = readFileSync(join(import.meta.dir, 'no-criteria-change.ts'), 'utf8');
    const imports = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.every((p) => p.startsWith('./'))).toBe(true);
    expect(src).not.toMatch(/\bfetch\s*\(|anthropic|openai|XMLHttpRequest|WebSocket/i);
  });
});

describe('criterionBlocks', () => {
  it('keeps each criterion with its label lines, in body order, under its section', () => {
    const { blocks, doubt } = criterionBlocks(BODY);
    expect(doubt).toBeNull();
    expect(blocks.map((b) => b.id)).toEqual(['R-1', 'R-2', 'D-1', 'AC-1']);
    expect(blocks[0]).toMatchObject({ section: 'Checkout > Requirements', lines: ['- R-1: Totals are in the shopper\'s currency.', '  check: `bun test fx.test.ts`'] });
    expect(blocks[3]!.lines).toEqual(['- AC-1: GIVEN a cart in EUR WHEN I check out THEN the total reads in EUR.', '  screen: checkout-total']);
  });
  it('a check line after a blank line still belongs to the criterion above', () => {
    const { blocks } = criterionBlocks('## R\n\nR-1: One.\n\ncheck: `x`\n\nSome prose.\n');
    expect(blocks).toEqual([{ id: 'R-1', section: 'R', lines: ['R-1: One.', 'check: `x`'] }]);
  });
  it('a table row criterion is its row', () => {
    const { blocks } = criterionBlocks('| Id | Text |\n| -- | -- |\n| R-1 | One |\n| note | prose |\n');
    expect(blocks).toEqual([{ id: 'R-1', section: '', lines: ['| R-1 | One |'] }]);
  });
  it('ignores ids inside fenced code', () => {
    expect(criterionBlocks('```\nR-1: not a criterion\n```\n').blocks).toEqual([]);
  });
});
