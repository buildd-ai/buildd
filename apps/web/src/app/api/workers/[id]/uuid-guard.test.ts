/**
 * Every handler under /api/workers/[id] must reject a non-UUID id before it
 * reaches the database.
 *
 * workers.id is a uuid column. Comparing it to a non-UUID makes Postgres throw
 * `invalid input syntax for type uuid` (22P02), which escaped each handler as
 * a 500. A runner holding a stale local record under a non-UUID id read that
 * as a transient fault and retried it on every reconcile pass. There is no
 * shared lookup helper these routes go through, so the guard is per-handler;
 * this pins it for every handler that exists now and any added later.
 *
 * Behaviour is covered in ./route.test.ts (GET/PATCH answer 404 without
 * querying); this is the structural half.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

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

const HANDLER = /export async function (GET|POST|PATCH|PUT|DELETE)\s*\(/g;

describe('/api/workers/[id] non-UUID guard', () => {
  const files = routeFiles(ROOT);

  it('finds the route tree', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    const src = readFileSync(file, 'utf8');
    const starts = [...src.matchAll(HANDLER)].map(m => ({ method: m[1], index: m.index! }));

    for (let i = 0; i < starts.length; i++) {
      const { method, index } = starts[i];
      const body = src.slice(index, i + 1 < starts.length ? starts[i + 1].index : undefined);

      it(`${rel} ${method} checks isUuid(id) before querying workers`, () => {
        if (!/const \{ id \} = await params/.test(body)) return; // handler takes no worker id
        const guard = body.search(/if \(!isUuid\(id\)\)/);
        expect(guard).toBeGreaterThan(-1);
        const firstQuery = body.search(/db\.(query|select|update|insert|delete)\b|eq\(workers\.id, id\)/);
        if (firstQuery > -1) expect(guard).toBeLessThan(firstQuery);
      });
    }
  }
});
