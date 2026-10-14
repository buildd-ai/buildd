import { describe, expect, it } from 'bun:test';
import { formatHints } from './format-hints';

const kinds = (body: string) => formatHints(body).map((h) => h.kind);

const FIVE_STEPS = [
  '## Checkout',
  '',
  '1. The shopper opens the cart.',
  '2. They pick a delivery slot.',
  '3. They pay.',
  '4. The order is confirmed.',
  '5. A receipt is sent.',
].join('\n');

describe('formatHints: diagram (R-48, AC-36)', () => {
  it('a five-step numbered flow with no diagram gets a diagram hint', () => {
    const hints = formatHints(FIVE_STEPS);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.kind).toBe('diagram');
    expect(hints[0]!.message).toContain('mermaid');
    expect(hints[0]!.message).toContain('5');
  });

  it('three steps is enough; continuation lines and blank lines between steps keep the run', () => {
    expect(kinds('1. Open\n   with detail\n\n2. Pick\n3. Pay')).toEqual(['diagram']);
    expect(kinds('1) Open\n2) Pick\n3) Pay')).toEqual(['diagram']);
  });

  it('two steps, or numbers that are not consecutive from 1, give no hint', () => {
    expect(kinds('1. Open\n2. Pick')).toEqual([]);
    expect(kinds('1. Open\n3. Pick\n5. Pay')).toEqual([]);
    expect(kinds('1. Open\nA paragraph breaks the run.\n2. Pick\n3. Pay')).toEqual([]);
  });

  it('a mermaid block anywhere silences it', () => {
    expect(kinds(`${FIVE_STEPS}\n\n\`\`\`mermaid\nflowchart LR\n  a --> b\n\`\`\``)).toEqual([]);
  });

  it('numbered steps inside fenced code are ignored', () => {
    expect(kinds('```text\n1. Open\n2. Pick\n3. Pay\n```')).toEqual([]);
    expect(kinds('~~~\n1. Open\n2. Pick\n3. Pay\n~~~')).toEqual([]);
  });
});

describe('formatHints: table (R-48)', () => {
  it('three parallel slash lines of the same shape get a table hint', () => {
    const body = '- Owner: read / write / approve\n- Member: read / write / none\n- Guest: read / none / none';
    const hints = formatHints(body);
    expect(hints.map((h) => h.kind)).toEqual(['table']);
    expect(hints[0]!.message).toContain('table');
  });

  it('three bold-labelled lines get a table hint, with the colon inside or outside the bold', () => {
    expect(kinds('- **Draft**: editable\n- **Submitted**: waits\n- **Approved**: in force')).toEqual(['table']);
    expect(kinds('* **Draft:** editable\n* **Submitted:** waits\n* **Approved:** in force')).toEqual(['table']);
  });

  it('lines of different shapes, or only two, give no hint', () => {
    expect(kinds('- Owner: read / write / approve\n- Member: read / write\n- Guest: read / none / none')).toEqual([]);
    expect(kinds('- **Draft**: editable\n- Member: read / write\n- **Approved**: in force')).toEqual([]);
    expect(kinds('- Owner: read / write\n- Member: read / none')).toEqual([]);
    expect(kinds('- plain item\n- another\n- a third')).toEqual([]);
    expect(kinds('- **R-1** a criterion\n- **R-2** another\n- **R-3** a third')).toEqual([]);
  });

  it('an existing table silences it', () => {
    const body = '- Owner: read / write / approve\n- Member: read / write / none\n- Guest: read / none / none\n\n| Role | Read |\n| --- | --- |\n| Owner | yes |';
    expect(kinds(body)).toEqual([]);
  });

  it('list lines inside fenced code are ignored, and a table inside fenced code does not silence', () => {
    expect(kinds('```\n- Owner: read / write / approve\n- Member: read / write / none\n- Guest: read / none / none\n```')).toEqual([]);
    const lines = '- Owner: read / write / approve\n- Member: read / write / none\n- Guest: read / none / none';
    expect(kinds(`${lines}\n\n\`\`\`\n| a | b |\n| --- | --- |\n\`\`\``)).toEqual(['table']);
  });
});

describe('formatHints: both and neither', () => {
  it('a body with both shapes gets both hints, diagram first', () => {
    expect(kinds(`${FIVE_STEPS}\n\n- Owner: read / write / approve\n- Member: read / write / none\n- Guest: read / none / none`)).toEqual(['diagram', 'table']);
  });
  it('plain prose and empty bodies give nothing', () => {
    expect(formatHints('')).toEqual([]);
    expect(formatHints('A paragraph.\n\nR-1 The thing works.')).toEqual([]);
  });
});
