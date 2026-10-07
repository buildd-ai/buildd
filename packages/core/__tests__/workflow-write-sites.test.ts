/**
 * Write-site guard for the workflow state kernel
 * (docs/specs/workflow-state-kernel.md §7.6, S14, AC-7): only
 * apps/web/src/lib/workflow/ touches the workflow_* tables and
 * trunk_incidents. Everything else reaches them through `ingestFact` /
 * `applyCommand`, so no sweep, route or reaper can assign delivery state.
 *
 * Blocking mode (Slice F, §13.10): the allowlist is empty. The scan covers
 * every deployed module (apps, packages, scripts), tests excluded by the same
 * rule as `pr-fact-write-sites.test.ts`, and it flags table ACCESS: raw SQL
 * that reads or writes a kernel table, and a Drizzle query builder handed one
 * of its table objects. A declaration is not access, so the schema needs no
 * exemption: `pgTable('workflow_deliveries', …)`, an FK `references(() => …)`
 * and `typeof workflowDeliveries.$inferSelect` name a table without touching it.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '../../..');
const tracked = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'], { cwd: repo })
  .stdout.toString()
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
/** Deployed source: tests are not write sites (same rule as the PR fact guard). */
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /__tests__\//.test(f) || /(^|\/)tests\//.test(f);
const files = tracked.filter((f) => !isTest(f));

const KERNEL_DIR = 'apps/web/src/lib/workflow/';
/** Slice F: empty. A module outside the kernel that needs a kernel table goes through the kernel. */
const ALLOWED = new Set<string>();

/**
 * S14: routes, sweeps and the reaper reach the kernel only through its route
 * API (seam.ts), the kill switch (authority.ts) and the live reader
 * (github-facts.ts); the composition root alone wires the effect handlers.
 * None of them imports the reducer, the CAS runner or the fact funnel, so none
 * can assign a delivery state.
 */
// Part 3 adds three, none of which can assign a state either: the read model
// (`projections` is pure, `delivery-view` only SELECTs) and the activity-note
// funnel (`pr-activity-effects` records a fact and enqueues a render, §12.1).
// Slice D adds `delivery-ship`: mission completion's input, a SELECT like `delivery-view`.
// Slice E adds `delivery-display`: the pure, serialisable slice of the read model that
// list surfaces carry to the client. No SQL, no command, so it cannot assign a state.
const KERNEL_ENTRY_POINTS = new Set(['seam', 'authority', 'github-facts', 'projections', 'delivery-view', 'pr-activity-effects', 'delivery-ship', 'delivery-display']);
const COMPOSITION_ROOT = 'apps/web/src/modules.ts';
const KERNEL_IMPORT = /(?:from\s+|import\()\s*['"](?:@\/lib\/workflow|(?:\.\.?\/)+(?:lib\/)?workflow)\/([a-z-]+)['"]/g;

const TABLES = 'workflow_deliveries|workflow_review_rounds|workflow_facts|workflow_transitions|workflow_effects|workflow_attempts|trunk_incidents';
const SYMBOLS = 'workflowDeliveries|workflowReviewRounds|workflowFacts|workflowTransitions|workflowEffects|workflowAttempts|trunkIncidents';
/** Raw SQL that reads or writes a kernel table: FROM, JOIN, INSERT INTO, UPDATE, DELETE FROM, TRUNCATE, ALTER/DROP TABLE. */
const SQL_ACCESS = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TRUNCATE|TABLE)\\s+(?:ONLY\\s+)?(?:(?:"?public"?)\\.)?"?(?:${TABLES})\\b`, 'i');
/** A Drizzle query builder over a kernel table object: db.insert/update/delete/select…from/join(t), db.query.t. */
const DRIZZLE_ACCESS = new RegExp(`(?:\\b(?:insert|update|delete|from|join|leftJoin|rightJoin|innerJoin|fullJoin)\\(\\s*(?:${SYMBOLS})\\b|\\.query\\.(?:${SYMBOLS})\\b)`);

function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('workflow kernel tables have one writer', () => {
  it('scans a real tree that contains the kernel and the schema', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(`${KERNEL_DIR}kernel.ts`);
    expect(files).toContain('packages/core/db/schema.ts');
  });

  it('blocking mode: the allowlist beyond apps/web/src/lib/workflow/ is empty', () => {
    expect([...ALLOWED]).toEqual([]);
  });

  it('no deployed module outside apps/web/src/lib/workflow/ reads or writes a kernel table in SQL', () => {
    const offenders = files.filter((f) => !f.startsWith(KERNEL_DIR) && !ALLOWED.has(f) && SQL_ACCESS.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('no deployed module outside apps/web/src/lib/workflow/ queries the Drizzle table objects', () => {
    const offenders = files.filter((f) => !f.startsWith(KERNEL_DIR) && !ALLOWED.has(f) && DRIZZLE_ACCESS.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('S14: outside the kernel, only its route API, kill switch and live reader are imported', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.startsWith(KERNEL_DIR) || ALLOWED.has(f) || !f.startsWith('apps/web/src/')) continue;
      for (const m of code(f).matchAll(KERNEL_IMPORT)) {
        if (!KERNEL_ENTRY_POINTS.has(m[1]) && f !== COMPOSITION_ROOT) offenders.push(`${f} → workflow/${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the S14 import scan can fail: it sees the route API being imported', () => {
    const hits = files.filter((f) => f.startsWith('apps/web/src/app/api/') && [...code(f).matchAll(KERNEL_IMPORT)].some((m) => m[1] === 'seam'));
    expect(hits.length).toBeGreaterThan(0);
    expect([...`import { reduce } from '@/lib/workflow/reducer';`.matchAll(KERNEL_IMPORT)].map((m) => m[1])).toEqual(['reducer']);
  });

  it('the guard can fail: it sees the kernel itself, and every access shape', () => {
    expect(SQL_ACCESS.test(code(`${KERNEL_DIR}kernel.ts`))).toBe(true);
    for (const s of [
      'UPDATE workflow_deliveries SET state = $1',
      'insert into "workflow_effects" (kind) values ($1)',
      'DELETE FROM public.workflow_attempts WHERE id = $1',
      'SELECT * FROM workflow_transitions tr JOIN trunk_incidents i ON true',
      'TRUNCATE workflow_facts',
    ]) expect(SQL_ACCESS.test(s)).toBe(true);
    for (const s of [
      'db.update(workflowDeliveries).set({ state: "MERGED" })',
      'db.insert(workflowEffects).values(row)',
      'db.select().from(workflowReviewRounds)',
      'db.query.trunkIncidents.findFirst()',
    ]) expect(DRIZZLE_ACCESS.test(s)).toBe(true);
  });

  it('a declaration is not access: the schema passes without an exemption', () => {
    const schema = code('packages/core/db/schema.ts');
    // It does declare the tables, so a pass here is the access rule, not an empty scan.
    expect(new RegExp(`pgTable\\('(?:${TABLES})'`).test(schema)).toBe(true);
    expect(SQL_ACCESS.test(schema)).toBe(false);
    expect(DRIZZLE_ACCESS.test(schema)).toBe(false);
    for (const s of [
      "export const workflowDeliveries = pgTable('workflow_deliveries', {",
      'deliveryId: uuid(\'delivery_id\').references(() => workflowDeliveries.id)',
      'export type WorkflowDeliveryRow = typeof workflowDeliveries.$inferSelect;',
      "uniqueIndex('workflow_deliveries_owner_unique')",
    ]) expect(SQL_ACCESS.test(s) || DRIZZLE_ACCESS.test(s)).toBe(false);
  });
});
