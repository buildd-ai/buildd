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

const repo = join(import.meta.dir, '../../..');
const files = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'], { cwd: repo })
  .stdout.toString()
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.tsx?$/.test(f) && !/__tests__\//.test(f) && !/\/tests\//.test(f));

const FUNNEL = 'packages/core/pr-facts.ts';
/**
 * Declarations and fixtures: the schema defines the columns; the demo stack
 * seeds a scripted timeline (simulated clocks, never a real PR) into its own
 * local database.
 */
const ALLOWED = new Set<string>(['packages/core/db/schema.ts', 'scripts/demo/advance.ts']);
/** A flagged line (or the line above it) carrying this marker is a write to another table. */
const NOT_A_WORKERS_WRITE = 'pr-fact-guard: not a workers write';

function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const GUARDED_KEY = /\b(prLifecycleStatus|mergedAt)\b/;
const GUARDED_COLUMN = /\b(pr_lifecycle_status|merged_at)\s*=/;

export function offendingSites(src: string): string[] {
  const out: string[] = [];
  const line = (i: number) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/\b(?:update|insert)\(\s*workers\s*\)/g)) {
    const rest = src.slice(m.index!);
    const end = rest.search(/\.(?:where|returning|onConflict\w*)\(|;\s*$/m);
    const block = rest.slice(0, end > 0 ? end : 1500);
    if (GUARDED_KEY.test(block)) out.push(`${m[0]}@${line(m.index!)}`);
  }
  for (const m of src.matchAll(/UPDATE\s+(?:"?workers"?)(?:\s+\w+)?\s+SET\b/gi)) {
    const rest = src.slice(m.index!);
    const end = rest.search(/\bWHERE\b|\bFROM\b/i);
    if (GUARDED_COLUMN.test(rest.slice(0, end > 0 ? end : 1500))) out.push(`raw UPDATE workers@${line(m.index!)}`);
  }
  if (/\b(?:update\(\s*workers\s*\)|UPDATE\s+"?workers"?\b)/i.test(src)) {
    for (const m of src.matchAll(/\b(prLifecycleStatus|mergedAt)\s*:\s*(?:'[a-z_]+'|"[a-z_]+"|new Date\b|sql`)/g)) {
      // A fact handed to the funnel (`{ kind: 'merged', mergedAt: … }`) is the sanctioned shape.
      if (/kind:\s*'merged',\s*$/.test(src.slice(Math.max(0, m.index! - 40), m.index!))) continue;
      out.push(`${m[1]} literal@${line(m.index!)}`);
    }
    for (const m of src.matchAll(/\.\s*(prLifecycleStatus|mergedAt)\s*=(?!=)/g)) out.push(`${m[1]} assignment@${line(m.index!)}`);
  }
  return out;
}

describe('the PR fact cache has one writer', () => {
  it('scans a real tree that contains the funnel', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(FUNNEL);
  });

  it('no module but recordPrFact writes workers.pr_lifecycle_status or workers.merged_at', () => {
    const offenders = files
      .filter((f) => f !== FUNNEL && !ALLOWED.has(f))
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
