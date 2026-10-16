/**
 * Write-site guard for the PR fact cache (docs/specs/workflow-state-kernel.md
 * §12, §14 row B): `workers.pr_lifecycle_status` and `workers.merged_at` are
 * written only by `recordPrFact` (packages/core/pr-facts.ts), which enforces
 * terminal-wins in its WHERE. Any other module that writes them reintroduces
 * the late-event regressions §16 S6 closes.
 *
 * The scan is textual, over tracked source, and errs toward flagging: a
 * Drizzle `update(workers)` whose `.set(...)` names a guarded column, a raw
 * `UPDATE workers SET` naming one, an `insert(workers)` carrying one, and, in
 * any module that updates `workers` at all, a guarded key assigned a literal
 * (the `recordCheck(id, { prLifecycleStatus: 'closed' })` shape).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { code, deployedFiles, offendingSites, repo } from './_write-site-scan';

const files = deployedFiles();

/** The funnel and its SQL (the projection T17 / T18 embed lives beside it). */
const FUNNEL = new Set(['packages/core/pr-facts.ts', 'packages/core/pr-fact-sql.ts']);
/**
 * Declarations and fixtures: the schema defines the columns; the demo stack
 * seeds a scripted timeline (simulated clocks, never a real PR) into its own
 * local database.
 */
const ALLOWED = new Set<string>(['packages/core/db/schema.ts', 'scripts/demo/advance.ts']);
/** A flagged line (or the line above it) carrying this marker is a write to another table. */
const NOT_A_WORKERS_WRITE = 'pr-fact-guard: not a workers write';

describe('the PR fact cache has one writer', () => {
  it('scans a real tree that contains the funnel', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const f of FUNNEL) expect(files).toContain(f);
  });

  it('no module but recordPrFact writes workers.pr_lifecycle_status or workers.merged_at', () => {
    const offenders = files
      .filter((f) => !FUNNEL.has(f) && !ALLOWED.has(f))
      .flatMap((f) => {
        const raw = readFileSync(join(repo, f), 'utf8').split('\n');
        return offendingSites(code(f))
          .filter((s) => {
            const n = Number(s.split('@').at(-1));
            return !(raw[n - 1]?.includes(NOT_A_WORKERS_WRITE) || raw[n - 2]?.includes(NOT_A_WORKERS_WRITE));
          })
          .map((s) => `${f} ${s}`);
      });
    expect(offenders).toEqual([]);
  });

  it('the guard can fail: it sees each writer shape', () => {
    expect(offendingSites(`await db.update(workers).set({ prLifecycleStatus: 'merged' }).where(eq(workers.id, id));`)).toHaveLength(2);
    expect(offendingSites(`await db.update(workers).set(update).where(x); update.mergedAt = new Date();`)).toEqual(['mergedAt assignment@1']);
    expect(offendingSites('await db.execute(sql`UPDATE workers SET merged_at = now() WHERE id = 1`)')).toEqual(['raw UPDATE workers@1']);
    expect(offendingSites(`await db.insert(workers).values({ prLifecycleStatus: lifecycle });`)).toEqual(['insert(workers)@1']);
    expect(offendingSites(`const recordCheck = () => db.update(workers).set({ ...extra }).where(x); recordCheck(id, { prLifecycleStatus: 'closed' });`))
      .toEqual(["prLifecycleStatus literal@1"]);
    expect(offendingSites(`db.update(workers).set({ x: 1 }).where(y); await recordPrFact({ workerId }, { kind: 'merged', mergedAt: new Date() });`)).toEqual([]);
    // Reads are not writes.
    expect(offendingSites(`db.query.workers.findFirst({ columns: { mergedAt: true, prLifecycleStatus: true } });`)).toEqual([]);
  });
});
