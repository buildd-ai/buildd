/**
 * Shared DB mock for spec-discrepancy-intake.test.ts.
 *
 * Only needs `db.select({...}).from(table).where(and(eq(...), eq(...), eq(...)))`
 * to resolve to whatever rows the test has staged in `store` — no persistence
 * semantics (unlike `_spec-discrepancy-db-mock.ts`, which proves cross-run
 * state) since `findIntakeWarnings` only ever reads.
 *
 * Not a *.test.ts file, so the runner won't collect it as a suite.
 */
import { mock } from 'bun:test';
import type { OpenCodeAheadRow } from '../spec-discrepancy-intake';

export let store: OpenCodeAheadRow[] = [];

export function setStore(rows: OpenCodeAheadRow[]): void {
  store = rows;
}

const specDiscrepanciesCols = {
  workspaceId: 'workspaceId',
  specPath: 'specPath',
  assertionId: 'assertionId',
  status: 'status',
  direction: 'direction',
  evidence: 'evidence',
};

export const db = {
  select(_cols: any) {
    return {
      from(_table: any) {
        return {
          where(_filter: any) {
            // Every call site filters on workspaceId + status='open' + direction='code_ahead' —
            // the fixture only ever stages rows meant to already satisfy that, so the mock
            // returns the staged set as-is rather than re-implementing filter evaluation.
            return Promise.resolve(store);
          },
        };
      },
    };
  },
};

export function installSpecDiscrepancyIntakeDbMock(): void {
  mock.module('../db', () => ({ db }));
  mock.module('../db/schema', () => ({ specDiscrepancies: specDiscrepanciesCols }));
  mock.module('drizzle-orm', () => ({
    eq: (col: any, val: any) => ({ type: 'eq', col, val }),
    and: (...args: any[]) => ({ type: 'and', args }),
  }));
}
