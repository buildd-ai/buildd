import { describe, it, expect } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import { accounts } from '@buildd/core/db/schema';

/**
 * Every relation in tasks/[id]/page.tsx's query shapes declares an explicit
 * `columns` allowlist -- `mission`, `parentTask`, `subTasks`, `creatorAccount`,
 * `creatorWorker`, `schedule`, the nested `workers` -- except `account`, which
 * was selected as `account: true` at three sites and therefore pulled every
 * column of the row into the server render for the two fields the page reads.
 *
 * Source-based for the same reason as page.test.ts in this directory: this is a
 * server component pulling in the DB client, drizzle, auth-helpers and
 * team-access, and re-deriving the query shape inside the test would prove
 * nothing about the page.
 */
const pageSource = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

/** The only fields the page reads off an account. */
const USED = ['name', 'authType'] as const;
const ALLOWLIST = `account: { columns: { ${USED.map(c => `${c}: true`).join(', ')} } }`;

/** How many account relations the page selects, root tree plus the worker reads. */
const ACCOUNT_RELATION_SITES = 3;

describe('tasks/[id]/page.tsx account relation', () => {
  it('never selects the account relation wholesale', () => {
    expect(pageSource).not.toContain('account: true');
  });

  it('declares the same explicit allowlist at every account site', () => {
    // The two worker reads must agree -- one is a re-read of the other after the
    // read-through merge-state refresh, and a divergence there would mean the
    // refreshed rows carry a different shape than the ones they replace.
    expect(pageSource.split(ALLOWLIST).length - 1).toBe(ACCOUNT_RELATION_SITES);
  });

  it('allowlists only fields the page actually reads', () => {
    for (const column of USED) {
      expect(pageSource).toContain(`.account?.${column}`);
    }
    // ...and nothing else. A field added to the allowlist without a reader is
    // how this relation drifts back towards `true`.
    const declared = [...pageSource.matchAll(/account: \{ columns: \{ ([^}]*)\} \}/g)]
      .map(m => m[1].split(',').map(s => s.trim().replace(/: true$/, '')).filter(Boolean));
    for (const site of declared) {
      expect(new Set(site)).toEqual(new Set(USED));
    }
  });

  it('allowlists real columns on the accounts table', () => {
    // A misspelling here is caught by drizzle at runtime, on a page nobody runs
    // in CI. Cheaper to catch it against the schema.
    const columns = new Set(Object.keys(getTableColumns(accounts)));
    for (const column of USED) {
      expect(columns).toContain(column);
    }
  });

  it('selects a small fraction of the row, which is the point of the change', () => {
    const total = Object.keys(getTableColumns(accounts)).length;
    expect(USED.length).toBeLessThan(total / 4);
  });
});
