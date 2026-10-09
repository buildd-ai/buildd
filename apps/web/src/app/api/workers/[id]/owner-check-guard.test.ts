/**
 * Every handler under /api/workers/[id] decides "is this caller the worker's
 * owner" through callerOwnsWorker (lib/worker-owner.ts), or its SQL form
 * ownedByCaller (lib/worker-park.ts) for a conditional UPDATE.
 *
 * An OAuth session resolves to an account its whole team shares, so comparing
 * the worker's account to the caller's says nothing about which member claimed
 * it. A handler that compares account ids directly lets any member of the team
 * act as another member's worker. Role-based paths that legitimately act on
 * others' workers (a team admin key, a dashboard member with workspace access)
 * are separate, named branches and do not compare account ids.
 *
 * Behaviour is covered per route in each route.test.ts; this is the
 * structural half, for every handler that exists now and any added later.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = import.meta.dir;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

/** An account-id-only owner test: `worker.accountId === account.id`, either way round, or as a WHERE. */
const ACCOUNT_ONLY = [
  /\.accountId\s*[!=]==?\s*\w+(\?|!)?\.id\b/,
  /\b\w+(\?|!)?\.id\s*[!=]==?\s*\w+\.accountId\b/,
  /eq\(\s*workers\.accountId\s*,/,
];

function accountOnlyOwnerChecks(src: string): string[] {
  return src.split('\n').filter(line => !line.trim().startsWith('//') && ACCOUNT_ONLY.some(re => re.test(line)));
}

describe('accountOnlyOwnerChecks (the checker itself)', () => {
  it('flags an account-only comparison, either way round, and a WHERE on accountId', () => {
    expect(accountOnlyOwnerChecks('if (worker.accountId !== account.id) return forbidden();')).toHaveLength(1);
    expect(accountOnlyOwnerChecks('const own = worker.accountId === apiAccount!.id;')).toHaveLength(1);
    expect(accountOnlyOwnerChecks('if (account.id !== worker.accountId) return nf();')).toHaveLength(1);
    expect(accountOnlyOwnerChecks('.where(and(eq(workers.id, id), eq(workers.accountId, account.id)))')).toHaveLength(1);
  });

  it('passes the owner helper and comments', () => {
    expect(accountOnlyOwnerChecks('if (!callerOwnsWorker(account, worker)) return forbidden();')).toEqual([]);
    expect(accountOnlyOwnerChecks('// worker.accountId !== account.id was the old check')).toEqual([]);
  });
});

describe('every /api/workers/[id] handler', () => {
  const files = routeFiles(ROOT);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${relative(ROOT, file)} has no account-id-only owner check`, () => {
      expect(accountOnlyOwnerChecks(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});
