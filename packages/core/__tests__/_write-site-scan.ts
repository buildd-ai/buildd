/**
 * Textual write-site scanners shared by the write-site guards
 * (`pr-fact-write-sites.test.ts`, `workflow-write-sites.test.ts`). Each errs toward
 * flagging: a guard that can miss a writer is worse than one that names a reader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const repo = join(import.meta.dir, '../../..');

/** Tracked deployed source under apps, packages and scripts: tests are not write sites. */
export function deployedFiles(): string[] {
  return Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'], { cwd: repo })
    .stdout.toString()
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.tsx?$/.test(f) && !/__tests__\//.test(f) && !/(^|\/)tests\//.test(f));
}

/** Source with comments blanked (line numbers kept), so a comment naming a column is not a write. */
export function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const GUARDED_KEY = /\b(prLifecycleStatus|mergedAt)\b/;
const GUARDED_COLUMN = /\b(pr_lifecycle_status|merged_at)\s*=/;

/**
 * Writes of `workers.pr_lifecycle_status` / `workers.merged_at`: a Drizzle
 * `update(workers)` whose `.set(...)` names one, a raw `UPDATE workers SET` naming one,
 * an `insert(workers)` carrying one, and, in any module that updates `workers` at all, a
 * guarded key assigned a literal (the `recordCheck(id, { prLifecycleStatus: 'closed' })` shape).
 */
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

/**
 * Writes of `tasks.status` / `tasks.result`: a Drizzle `update(tasks)` whose `.set(...)` names
 * either key or takes a variable (its keys cannot be read), and a raw `UPDATE tasks [alias] SET`
 * assigning either column.
 */
export function taskStatusSites(src: string): string[] {
  const out: string[] = [];
  const line = (i: number) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/\bupdate\(\s*tasks\s*\)/g)) {
    const rest = src.slice(m.index!);
    const end = rest.search(/\.(?:where|returning)\(/);
    const block = rest.slice(0, end > 0 ? end : 1500);
    if (/\b(status|result)\b\s*[:,}]/.test(block) || /\.set\(\s*(?!\{)/.test(block)) out.push(`update(tasks)@${line(m.index!)}`);
  }
  for (const m of src.matchAll(/UPDATE\s+"?tasks"?(?:\s+(?!SET\b)\w+)?\s+SET\b/gi)) {
    const rest = src.slice(m.index!);
    const end = rest.search(/\bWHERE\b|\bFROM\b/i);
    if (/\b(status|result)\s*=/.test(rest.slice(0, end > 0 ? end : 1500))) out.push(`raw UPDATE tasks@${line(m.index!)}`);
  }
  return out;
}
