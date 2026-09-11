/**
 * Stateful in-memory fake DB for spec-discrepancy-ledger.test.ts.
 *
 * Unlike `_db-mock.ts` (a single insert chain with a knob for `.returning()`),
 * this module needs to prove real cross-run persistence — "the same
 * assertion failing across two runs updates one row rather than creating
 * two" can't be verified against a stateless chain, so this fake keeps rows
 * in a real Map keyed by (workspaceId, specPath, assertionId) and evaluates
 * `eq`/`and` filter trees against it, mirroring what Postgres would do for
 * the plain equality WHERE clauses spec-discrepancy-ledger.ts issues.
 *
 * Not a *.test.ts file, so the runner won't collect it as a suite.
 */
import { mock } from 'bun:test';

export const store = new Map<string, any>();

export function resetStore(): void {
  store.clear();
}

function keyOf(row: { workspaceId: string; specPath: string; assertionId: string }): string {
  return `${row.workspaceId}::${row.specPath}::${row.assertionId}`;
}

function matches(row: any, filter: any): boolean {
  if (!filter) return true;
  if (filter.type === 'and') return filter.args.every((f: any) => matches(row, f));
  if (filter.type === 'eq') return row[filter.col] === filter.val;
  return true;
}

// Column objects are just their own field-name strings — `eq(specDiscrepancies.status, x)`
// becomes `eq('status', x)`, so the filter tree can look values up on a plain row object.
const specDiscrepanciesCols = {
  workspaceId: 'workspaceId',
  specPath: 'specPath',
  assertionId: 'assertionId',
  direction: 'direction',
  status: 'status',
  firstSeenAt: 'firstSeenAt',
  lastCheckedAt: 'lastCheckedAt',
  evidence: 'evidence',
};

export const db = {
  select(_cols: any) {
    return {
      from(_table: any) {
        return {
          where(filter: any) {
            const rows = [...store.values()].filter((r) => matches(r, filter));
            return Promise.resolve(rows.map((r) => ({ status: r.status, firstSeenAt: r.firstSeenAt })));
          },
        };
      },
    };
  },
  insert(_table: any) {
    return {
      values(vals: any) {
        store.set(keyOf(vals), { ...vals });
        return Promise.resolve();
      },
    };
  },
  update(_table: any) {
    return {
      set(vals: any) {
        return {
          where(filter: any) {
            for (const [k, r] of store) {
              if (matches(r, filter)) store.set(k, { ...r, ...vals });
            }
            return Promise.resolve();
          },
        };
      },
    };
  },
};

export function installSpecDiscrepancyDbMock(): void {
  mock.module('../db', () => ({ db }));
  mock.module('../db/schema', () => ({ specDiscrepancies: specDiscrepanciesCols }));
  mock.module('drizzle-orm', () => ({
    eq: (col: any, val: any) => ({ type: 'eq', col, val }),
    and: (...args: any[]) => ({ type: 'and', args }),
  }));
}
