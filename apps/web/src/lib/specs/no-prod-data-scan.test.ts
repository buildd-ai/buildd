import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BIG, PROD_CONTEXT, scanForProdData, TENANCY, UNITS, VOLUME } from './no-prod-data-scan';
import { PUBLIC_DOCS_GUARDED_DIRS } from './repo-copy';
import { GUARDED_DIRS } from '../../../../../scripts/check-public-docs';

// The R-34 preflight runs the repo's checks, not a port that drifts from them.
const REPO = join(import.meta.dir, '../../../../..');
const PY = readFileSync(join(REPO, 'scripts/check_no_prod_data.py'), 'utf8');

/** A Python pattern assignment: one raw string, or a parenthesised run of raw strings. */
function pyPattern(name: string): string {
  const m = new RegExp(String.raw`^${name} = (\([\s\S]*?\n\)|r"[^"\n]*")`, 'm').exec(PY);
  if (!m) throw new Error(`${name} not found in check_no_prod_data.py`);
  return [...m[1]!.matchAll(/r"([^"]*)"/g)].map((x) => x[1]).join('');
}

describe('the preflight uses the repo checks', () => {
  it('reads every pattern it copies (the parser can fail)', () => {
    expect(() => pyPattern('NOT_A_PATTERN')).toThrow();
  });

  it('no-prod-data patterns match scripts/check_no_prod_data.py exactly', () => {
    expect(TENANCY).toBe(pyPattern('TENANCY'));
    expect(VOLUME).toBe(pyPattern('VOLUME'));
    expect(BIG).toBe(pyPattern('BIG'));
    expect(UNITS).toBe(pyPattern('UNITS'));
    expect(PROD_CONTEXT).toBe(pyPattern('PROD_CONTEXT'));
  });

  it('public-docs guarded directories match scripts/check-public-docs.ts', () => {
    expect([...PUBLIC_DOCS_GUARDED_DIRS]).toEqual([...GUARDED_DIRS]);
  });
});

describe('scanForProdData', () => {
  it('finds a UUID in a source line, and never repeats the value', () => {
    const hits = scanForProdData('ok\nspec 1a2b3c4d-0000-4000-8000-00000000abcd here', { code: true });
    expect(hits).toEqual(['line 2: a UUID (row identifiers must not enter a public repo)']);
  });

  it('finds a population count in prose but not in code', () => {
    expect(scanForProdData('we have 12 teams on it', { code: false })).toHaveLength(1);
    expect(scanForProdData('we have 12 teams on it', { code: true })).toEqual([]);
    expect(scanForProdData('cap at 60 workers', { code: false })).toEqual([]);
  });
});
