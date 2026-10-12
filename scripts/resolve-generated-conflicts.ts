#!/usr/bin/env bun
/**
 * Resolve the merge conflicts a script can resolve, and list the rest.
 *
 * Run it right after `git merge origin/<trunk>` stops on conflicts. It touches
 * only generated files (`isGeneratedArtifactPath`), regenerating each one
 * instead of reading both sides, and leaves every other conflict alone:
 *
 *   - `docs/specs/INDEX.md`: take trunk's copy, then `bun run specs:check`
 *     regenerates it. Waits while a spec file itself is still conflicted.
 *   - `packages/core/drizzle/**`: `regenerateAgainstBase` against the trunk
 *     being merged (the same repair `bun run migrations:regenerate` runs): trunk's
 *     migration folders as they are, and this branch's schema change
 *     regenerated on top of them. A conflict here is a branch cut before the
 *     drizzle v1 cutover (its journal was modified, trunk deleted it), or two
 *     branches that touched one folder. Runs last and waits while any other
 *     conflict remains (`schema.ts` must hold both sides). If the regenerated
 *     SQL is not the SQL it replaced, a person checks the result. Whatever the
 *     repair leaves must pass the fail-closed layout check (no legacy `.sql`
 *     next to v1 folders), or it is not called resolved.
 *   - `scripts/design-check.baseline.json`: a three-way merge of the per-file
 *     counts (ours + theirs - base), then `bun run design:check --update`
 *     lowers it to today's counts. Waits while a file under apps/web/src is
 *     conflicted (its markers hold both sides, so the counts would double). A
 *     rule the merged code pushes above both sides is left for a person.
 *
 * Exit 0: no conflicts remain. Exit 2: some remain (listed). Exit 1: not in a
 * merge, or a command failed. Safe to run again after resolving the rest.
 *
 * Spec: docs/specs/mission-branch-refresh.md ("Resolving a refresh conflict").
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESIGN_CHECK_BASELINE_PATH,
  DRIZZLE_DIR,
  SPECS_INDEX_PATH,
  isGeneratedArtifactPath,
} from '../packages/core/generated-artifacts';
import { regenerateAgainstBase, type RegenerateResult } from '../packages/core/db/migration-layout';
import { detectLayout, v1LayoutProblems } from '../packages/core/db/migrate-tree';

export interface Run {
  (cmd: string, args: string[], opts?: { cwd?: string }): { status: number; stdout: string; stderr: string };
}

export const realRun: Run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export type Step =
  | { path: string; result: 'resolved' }
  | { path: string; result: 'waiting'; reason: string }
  | { path: string; result: 'needs_person'; reason: string };

export interface Report {
  steps: Step[];
  remaining: string[];
}

// ── Pure parts ──────────────────────────────────────────────────────────────

type Counts = Record<string, Record<string, number>>;

/**
 * Three-way merge of design-check counts, per file, the way git merges a line:
 * a count both sides agree on, or only one side changed, is that count; only
 * when both changed it differently is each side's change kept (ours + theirs -
 * base), so a file both sides added violations to carries both.
 */
export function mergeBaselineCounts(base: Counts, ours: Counts, theirs: Counts): Counts {
  const out: Counts = {};
  for (const rule of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = base[rule] ?? {}, o = ours[rule] ?? {}, t = theirs[rule] ?? {};
    const merged: Record<string, number> = {};
    for (const file of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
      const ob = o[file] ?? 0, tb = t[file] ?? 0, bb = b[file] ?? 0;
      const n = ob === tb ? ob : ob === bb ? tb : tb === bb ? ob : ob + tb - bb;
      if (n > 0) merged[file] = n;
    }
    out[rule] = merged;
  }
  return out;
}

// ── Git reads ───────────────────────────────────────────────────────────────

function git(run: Run, root: string, args: string[]): string {
  const r = run('git', args, { cwd: root });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export function conflictedPaths(run: Run, root: string): string[] {
  return git(run, root, ['diff', '--name-only', '--diff-filter=U']).split('\n').map((s) => s.trim()).filter(Boolean);
}

function stage(run: Run, root: string, n: 1 | 2 | 3, path: string): string | null {
  const r = run('git', ['show', `:${n}:${path}`], { cwd: root });
  return r.status === 0 ? r.stdout : null;
}

function parseCounts(raw: string | null): Counts {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Counts) : {};
  } catch {
    return {};
  }
}

// ── Resolvers ───────────────────────────────────────────────────────────────

function resolveSpecsIndex(run: Run, root: string, conflicted: string[]): Step {
  const blocking = conflicted.filter((p) => p !== SPECS_INDEX_PATH && p.startsWith('docs/specs/'));
  if (blocking.length > 0) {
    return { path: SPECS_INDEX_PATH, result: 'waiting', reason: `resolve ${blocking.join(', ')} first, then run this again` };
  }
  git(run, root, ['checkout', '--theirs', '--', SPECS_INDEX_PATH]);
  const regen = run('bun', ['run', 'specs:check'], { cwd: root });
  if (!existsSync(join(root, SPECS_INDEX_PATH)) || readFileSync(join(root, SPECS_INDEX_PATH), 'utf8').includes('<<<<<<<')) {
    return { path: SPECS_INDEX_PATH, result: 'needs_person', reason: `specs:check did not regenerate it: ${regen.stderr.trim().split('\n').pop() ?? ''}` };
  }
  git(run, root, ['add', '--', SPECS_INDEX_PATH]);
  return { path: SPECS_INDEX_PATH, result: 'resolved' };
}

/** The drizzle repair, injectable so a test need not run drizzle-kit. */
export type Regenerate = (root: string) => RegenerateResult;
const realRegenerate: Regenerate = (root) => regenerateAgainstBase({ root, drizzleDir: DRIZZLE_DIR.replace(/\/$/, '') }, 'MERGE_HEAD');

function resolveDrizzle(root: string, conflicted: string[], regenerate: Regenerate): Step {
  const blocking = conflicted.filter((p) => !p.startsWith(DRIZZLE_DIR));
  if (blocking.length > 0) {
    return { path: DRIZZLE_DIR, result: 'waiting', reason: `resolve ${blocking.join(', ')} first (the migrations regenerate from the merged schema.ts), then run this again` };
  }
  let r: RegenerateResult;
  try {
    r = regenerate(root);
  } catch (err) {
    return { path: DRIZZLE_DIR, result: 'needs_person', reason: err instanceof Error ? err.message : String(err) };
  }
  const layout = layoutAfterRepair(join(root, DRIZZLE_DIR));
  if (layout.length > 0) {
    return { path: DRIZZLE_DIR, result: 'needs_person', reason: `the repaired migrations dir fails the layout check: ${layout.join('; ')}` };
  }
  if (r.sqlChanged) {
    return {
      path: DRIZZLE_DIR,
      result: 'needs_person',
      reason: `regenerated ${r.generated.join(', ') || 'nothing'} in place of ${r.removed.join(', ') || 'nothing'}, and its SQL differs from what it replaced. Read both: a hand-written statement in the old file is not carried over. Re-add it with \`bun db:generate --custom\`, never by editing an existing file`,
    };
  }
  return { path: DRIZZLE_DIR, result: 'resolved' };
}

/** Fail-closed: a legacy file left next to v1 folders would never be applied. */
function layoutAfterRepair(dir: string): string[] {
  try {
    return detectLayout(dir) === 'v1' ? v1LayoutProblems(dir) : [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

/** Where design:check counts violations: a conflicted file there still holds both sides' text. */
export const DESIGN_SCAN_ROOT = 'apps/web/src/';

function resolveDesignBaseline(run: Run, root: string, conflicted: string[]): Step {
  const blocking = conflicted.filter((p) => p.startsWith(DESIGN_SCAN_ROOT));
  if (blocking.length > 0) {
    return { path: DESIGN_CHECK_BASELINE_PATH, result: 'waiting', reason: `resolve ${blocking.join(', ')} first (design:check would count both sides of its conflict), then run this again` };
  }
  const merged = mergeBaselineCounts(
    parseCounts(stage(run, root, 1, DESIGN_CHECK_BASELINE_PATH)),
    parseCounts(stage(run, root, 2, DESIGN_CHECK_BASELINE_PATH)),
    parseCounts(stage(run, root, 3, DESIGN_CHECK_BASELINE_PATH)),
  );
  writeFileSync(join(root, DESIGN_CHECK_BASELINE_PATH), JSON.stringify(merged, null, 2) + '\n');
  const update = run('bun', ['run', 'design:check', '--update'], { cwd: root });
  if (update.status !== 0) {
    const said = `${update.stdout}\n${update.stderr}`.trim().split('\n').filter(Boolean).slice(-3).join(' / ');
    return { path: DESIGN_CHECK_BASELINE_PATH, result: 'needs_person', reason: `design:check --update refused (${said}). Fix the debt it names, or raise the baseline deliberately with --allow-increase` };
  }
  git(run, root, ['add', '--', DESIGN_CHECK_BASELINE_PATH]);
  return { path: DESIGN_CHECK_BASELINE_PATH, result: 'resolved' };
}

// ── Entry ───────────────────────────────────────────────────────────────────

export function resolveGeneratedConflicts(root: string, run: Run = realRun, regenerate: Regenerate = realRegenerate): Report {
  if (run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root }).status !== 0) {
    throw new Error('not in the middle of a merge: run `git merge origin/<trunk>` first');
  }
  const steps: Step[] = [];
  // Drizzle last: renumbering needs every other conflict settled, and the two
  // regenerations before it settle theirs.
  if (conflictedPaths(run, root).includes(DESIGN_CHECK_BASELINE_PATH)) steps.push(resolveDesignBaseline(run, root, conflictedPaths(run, root)));
  if (conflictedPaths(run, root).includes(SPECS_INDEX_PATH)) steps.push(resolveSpecsIndex(run, root, conflictedPaths(run, root)));
  const before = conflictedPaths(run, root);
  if (before.some((p) => p.startsWith(DRIZZLE_DIR))) steps.push(resolveDrizzle(root, before, regenerate));
  const remaining = conflictedPaths(run, root);
  const unsettled = steps.filter((s) => s.result !== 'resolved').map((s) => s.path);
  return { steps, remaining: [...new Set([...remaining, ...unsettled])] };
}

export function exitCodeFor(report: Report): 0 | 2 {
  return report.remaining.length === 0 ? 0 : 2;
}

if (import.meta.main) {
  const root = realRun('git', ['rev-parse', '--show-toplevel']).stdout.trim() || process.cwd();
  try {
    const report = resolveGeneratedConflicts(root);
    for (const s of report.steps) {
      if (s.result === 'resolved') console.log(`resolved   ${s.path}`);
      else console.log(`${s.result === 'waiting' ? 'waiting   ' : 'NEEDS YOU '} ${s.path}: ${s.reason}`);
    }
    const real = report.remaining.filter((p) => !isGeneratedArtifactPath(p));
    if (report.remaining.length === 0) {
      console.log('\nNo conflicts remain. Review the result, run the tests, and commit the merge.');
    } else {
      console.log(`\nStill to resolve by hand (${report.remaining.length}):`);
      for (const p of report.remaining) console.log(`  ${p}`);
      if (real.length > 0) console.log('\nResolve those on their merits, then run this again to finish the generated files.');
    }
    process.exit(exitCodeFor(report));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
