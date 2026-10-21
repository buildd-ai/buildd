import { describe, expect, it } from 'bun:test';
import { BIG, PROD_CONTEXT, scanForProdData, TENANCY, UNITS, VOLUME } from './no-prod-data-scan';
import { PUBLIC_DOCS_GUARDED_DIRS } from './repo-copy';
import { GUARDED_DIRS } from '../../../../../scripts/check-public-docs';
import * as gate from '../../../../../scripts/check-no-prod-data';

// The R-34 preflight runs the repo's checks, not a port that drifts from them.
describe('the preflight uses the repo checks', () => {
  it('no-prod-data patterns match scripts/check-no-prod-data.ts exactly', () => {
    expect(TENANCY).toBe(gate.TENANCY);
    expect(VOLUME).toBe(gate.VOLUME);
    expect(BIG).toBe(gate.BIG);
    expect(UNITS).toBe(gate.UNITS);
    expect(PROD_CONTEXT).toBe(gate.PROD_CONTEXT);
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
