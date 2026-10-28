import { describe, expect, it } from 'bun:test';
import { compareAcceptanceStrictness } from './acceptance-strictness';

const t = (body: string, name = 'queues a task') => `import { it, expect } from 'bun:test';\nit('${name}', () => {\n${body}\n});\n`;

describe('compareAcceptanceStrictness', () => {
  it('stricter: an assertion is added', () => {
    const r = compareAcceptanceStrictness(t(`expect(a).toBe(1);`), t(`expect(a).toBe(1);\nexpect(b).toEqual({ x: 1 });`));
    expect(r.verdict).toBe('stricter');
    expect(r.weakened).toEqual([]);
  });

  it('stricter: a loose matcher becomes an exact one', () => {
    expect(compareAcceptanceStrictness(t(`expect(list).toContain('a');`), t(`expect(list).toBe('a');`)).verdict).toBe('stricter');
  });

  it('stricter: a tolerance narrows', () => {
    expect(compareAcceptanceStrictness(t(`expect(x).toBeCloseTo(1, 1);`), t(`expect(x).toBeCloseTo(1, 4);`)).verdict).toBe('stricter');
  });

  it('equivalent: formatting, quotes and comments only', () => {
    const r = compareAcceptanceStrictness(t(`expect(a).toBe("x y");`), t(`  // why\n  expect( a )\n    .toBe('x y');`));
    expect(r.verdict).toBe('equivalent');
  });

  it('loosened: an assertion is removed, and which one is named', () => {
    const r = compareAcceptanceStrictness(t(`expect(a).toBe(1);\nexpect(res.status).toBe(200);`), t(`expect(a).toBe(1);`));
    expect(r.verdict).toBe('loosened');
    expect(r.weakened).toHaveLength(1);
    expect(r.weakened[0]!.kind).toBe('removed');
    expect(r.weakened[0]!.text).toContain('res.status');
  });

  it('loosened: toBe becomes toContain', () => {
    const r = compareAcceptanceStrictness(t(`expect(msg).toBe('done');`), t(`expect(msg).toContain('done');`));
    expect(r.verdict).toBe('loosened');
    expect(r.weakened[0]!.kind).toBe('matcher');
    expect(r.weakened[0]!.text).toContain('msg');
  });

  it('loosened: a regex or tolerance is widened', () => {
    expect(compareAcceptanceStrictness(t(`expect(s).toMatch(/^ok$/);`), t(`expect(s).toMatch(/ok.*/);`)).weakened[0]!.kind).toBe('widened');
    expect(compareAcceptanceStrictness(t(`expect(x).toBeCloseTo(1, 4);`), t(`expect(x).toBeCloseTo(1, 1);`)).weakened[0]!.kind).toBe('widened');
    expect(compareAcceptanceStrictness(t(`expect(n).toBeGreaterThan(10);`), t(`expect(n).toBeGreaterThan(1);`)).verdict).toBe('loosened');
  });

  it('loosened: a test is dropped, skipped, or its file deleted', () => {
    const two = t(`expect(a).toBe(1);`, 'one') + t(`expect(b).toBe(2);`, 'two');
    const drop = compareAcceptanceStrictness(two, t(`expect(a).toBe(1);`, 'one'));
    expect(drop.weakened[0]).toMatchObject({ kind: 'test_dropped' });
    expect(drop.weakened[0]!.text).toContain('two');
    expect(compareAcceptanceStrictness(t(`expect(a).toBe(1);`), t(`expect(a).toBe(1);`).replace("it('", "it.skip('")).weakened[0]!.kind).toBe('skipped');
    expect(compareAcceptanceStrictness(t(`expect(a).toBe(1);`), null).weakened[0]!.kind).toBe('file_removed');
  });

  it('loosened: setup around the tests is changed', () => {
    const r = compareAcceptanceStrictness(t(`const v = build(2);\nexpect(v).toBe(1);`), t(`const v = build(0);\nexpect(v).toBe(1);`));
    expect(r.verdict).toBe('loosened');
    expect(r.weakened[0]!.kind).toBe('setup');
  });

  it('unparseable: broken source or tests it cannot name', () => {
    expect(compareAcceptanceStrictness(t(`expect(a).toBe(1);`), `it('x', () => {\n expect(a).toBe(1);`).verdict).toBe('unparseable');
    expect(compareAcceptanceStrictness(t(`expect(a).toBe(1);`), `it.each([1,2])('n %i', (n) => { expect(n).toBe(n); });`).verdict).toBe('unparseable');
    expect(compareAcceptanceStrictness('const a = 1;', 'const a = 2;').verdict).toBe('unparseable');
  });

  it('a new test file is stricter', () => {
    expect(compareAcceptanceStrictness(null, t(`expect(a).toBe(1);`)).verdict).toBe('stricter');
  });
});
