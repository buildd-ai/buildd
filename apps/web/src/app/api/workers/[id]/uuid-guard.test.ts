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
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

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

describe('uuidGuardViolations (the checker itself)', () => {
  const ok = `export async function GET(req, { params }) {
    const { id } = await params;
    if (!isUuid(id)) return nf();
    await db.query.workers.findFirst({ where: eq(workers.id, id) });
  }`;

  it('passes a guarded handler', () => {
    expect(uuidGuardViolations(ok)).toEqual([]);
  });

  it('flags a missing guard', () => {
    expect(uuidGuardViolations(ok.replace('if (!isUuid(id)) return nf();', ''))).toHaveLength(1);
  });

  it('flags a guard placed after the first query', () => {
    const src = `export async function GET(req, { params }) {
      const { id } = await params;
      await db.query.workers.findFirst({ where: eq(workers.id, id) });
      if (!isUuid(id)) return nf();
    }`;
    expect(uuidGuardViolations(src)).toHaveLength(1);
  });

  it('flags a renamed destructure instead of skipping it', () => {
    const src = `export async function GET(req, { params }) {
      const { id: workerId } = await params;
      await db.query.workers.findFirst({ where: eq(workers.id, workerId) });
    }`;
    expect(uuidGuardViolations(src)).toHaveLength(1);
  });

  it('flags an inline params read instead of skipping it', () => {
    const src = `export async function GET(req, { params }) {
      await db.query.workers.findFirst({ where: eq(workers.id, (await params).id) });
    }`;
    expect(uuidGuardViolations(src)).toHaveLength(1);
  });

  it('flags a handler exported in a shape the body check cannot see', () => {
    const src = `export const POST = withAuth(async (req, { params }) => {
      const { id } = await params;
      await db.query.workers.findFirst({ where: eq(workers.id, id) });
    });`;
    expect(uuidGuardViolations(src).length).toBeGreaterThan(0);
  });

  it('does not accept a commented-out guard', () => {
    expect(uuidGuardViolations(ok.replace('if (!isUuid(id)) return nf();', '// if (!isUuid(id)) return nf();'))).toHaveLength(1);
  });
});

describe('/api/workers/[id] non-UUID guard', () => {
  const files = routeFiles(ROOT);

  it('finds the route tree', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    it(`${rel} checks isUuid(id) before querying in every handler`, () => {
      expect(uuidGuardViolations(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});
