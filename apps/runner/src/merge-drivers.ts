/**
 * Derived-file merge drivers (`gitConfig.derivedFiles`).
 *
 * A lockfile or generated index is never resolved by reading both sides: the
 * right answer is to take one side and re-run the generator. This registers a
 * git merge driver per rule in the runner's own clone (`.git/config` plus the
 * common dir's `info/attributes` — nothing in the repo changes), so any merge in
 * that clone, the runner's or the agent's, resolves those files without a
 * conflict and records which generator is owed.
 *
 * For a conflict retry, `mergeBaseWithDerivedFiles` does the merge before the
 * agent starts: derived-only conflicts come out as a finished merge commit with
 * the regenerated files in it; mixed ones leave the merge in progress with only
 * the real conflicts unresolved, and the owed commands for the agent to run.
 *
 * Deliberately no "concatenate both sides" rule (`merge=union`): replayed
 * against real resolutions it duplicated changes the base already carried more
 * often than it was right. Real text conflicts stay with the agent.
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import type { DerivedFileRule } from '@buildd/shared';

export type NormalizedDerivedFileRule = Required<DerivedFileRule>;

const MAX_RULES = 20;
const REGENERATE_TIMEOUT_MS = 5 * 60_000;
const PENDING_FILE = 'buildd-derived-pending';
const BLOCK_START = '# >>> buildd derived files (managed by the buildd runner) >>>';
const BLOCK_END = '# <<< buildd derived files <<<';

/** Patterns that cover (nearly) the whole tree: a driver there would swallow real conflicts. */
const REPO_WIDE = /^[/*]*$/;

/**
 * Migration chains are never regenerated: renumbering reorders schema changes,
 * and each file carries DDL only its author can reproduce. The drizzle journal
 * included — the migration-collision path owns it.
 */
const MIGRATION_CHAIN = /(^|\/)(drizzle|migrations?|migrate|alembic|versions)(\/|$)|\.sql$/i;

/** Read `gitConfig.derivedFiles` defensively: anything unsafe or malformed is dropped. */
export function normalizeDerivedFiles(input: unknown): NormalizedDerivedFileRule[] {
  if (!Array.isArray(input)) return [];
  const out: NormalizedDerivedFileRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const glob = typeof r.glob === 'string' ? r.glob.trim() : '';
    const regenerate = typeof r.regenerate === 'string' ? r.regenerate.trim() : '';
    if (!glob || !regenerate) continue;
    // gitattributes patterns are whitespace-delimited; one with a space can't be a single pattern.
    if (/\s/.test(glob) || glob.startsWith('#') || glob.startsWith('!')) continue;
    if (REPO_WIDE.test(glob) || MIGRATION_CHAIN.test(glob)) continue;
    out.push({ glob, regenerate, strategy: r.strategy === 'ours' ? 'ours' : 'theirs' });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/** Languages mergiraf parses, as gitattributes patterns. */
const MERGIRAF_PATTERNS = [
  '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.json', '*.yaml', '*.yml',
  '*.toml', '*.py', '*.rs', '*.go',
];

export interface MergeDriverOptions {
  /** Workspace opt-in (`gitConfig.mergiraf`). */
  mergiraf: boolean;
  /** Resolved binary; `undefined` = look it up on PATH, `null` = known absent. */
  mergirafPath?: string | null;
}

export interface MergeDriverPlan {
  config: Array<[string, string]>;
  attributes: string[];
}

function driverName(index: number): string {
  return `buildd-derived-${index}`;
}

/**
 * The driver keeps one side whole (git has already put "ours" at %A; "theirs"
 * copies %B over it), then appends the rule's index to a per-worktree pending
 * file so the generator runs once the whole merge is settled.
 */
function driverCommand(index: number, strategy: 'ours' | 'theirs'): string {
  const keep = strategy === 'theirs' ? 'cp "$2" "$1" && ' : '';
  return `sh -c '${keep}echo ${index} >> "$(git rev-parse --git-dir)/${PENDING_FILE}"' buildd-derived %A %B`;
}

export function planMergeDrivers(rules: NormalizedDerivedFileRule[], opts: MergeDriverOptions): MergeDriverPlan {
  const config: Array<[string, string]> = [];
  const attributes: string[] = [];
  const mergiraf = opts.mergiraf && opts.mergirafPath ? opts.mergirafPath : null;
  if (mergiraf) {
    config.push(['merge.mergiraf.name', 'mergiraf (structural merge)']);
    config.push(['merge.mergiraf.driver', `${mergiraf} merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L`]);
    for (const p of MERGIRAF_PATTERNS) attributes.push(`${p} merge=mergiraf`);
  }
  // Derived rules last: in gitattributes the later matching line wins, so a
  // lockfile that is also `*.json` gets the regenerate driver, not mergiraf.
  rules.forEach((rule, i) => {
    config.push([`merge.${driverName(i)}.name`, `buildd derived file (${rule.glob})`]);
    config.push([`merge.${driverName(i)}.driver`, driverCommand(i, rule.strategy)]);
    attributes.push(`${rule.glob} merge=${driverName(i)}`);
  });
  return { config, attributes };
}

// ── Register ─────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[], timeout = 30_000): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? err) };
  }
}

function gitPath(cwd: string, flag: '--git-dir' | '--git-common-dir'): string {
  const p = git(cwd, ['rev-parse', flag]);
  return isAbsolute(p) ? p : join(cwd, p);
}

function findMergiraf(): string | null {
  try {
    const p = execSync('command -v mergiraf', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/sh' }).trim();
    return p || null;
  } catch {
    return null;
  }
}

function replaceManagedBlock(existing: string, lines: string[]): string {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  let rest = existing;
  if (start !== -1 && end > start) {
    rest = existing.slice(0, start) + existing.slice(end + BLOCK_END.length);
  }
  rest = rest.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  if (lines.length === 0) return rest;
  const sep = rest.length === 0 || rest.endsWith('\n') ? '' : '\n';
  return `${rest}${sep}${BLOCK_START}\n${lines.join('\n')}\n${BLOCK_END}\n`;
}

/**
 * Point this clone's merges at the derived-file drivers. Idempotent; an empty
 * rule list removes what an earlier registration added. Also turns on rerere so
 * a resolution recorded once replays on the next attempt.
 */
export function registerMergeDrivers(
  worktreePath: string,
  rules: NormalizedDerivedFileRule[],
  opts: MergeDriverOptions,
): MergeDriverPlan {
  const mergirafPath = opts.mergiraf
    ? (opts.mergirafPath === undefined ? findMergiraf() : opts.mergirafPath)
    : null;
  if (opts.mergiraf && !mergirafPath) {
    console.log('[merge-drivers] mergiraf enabled for this workspace but not installed — skipping it');
  }
  const plan = planMergeDrivers(rules, { mergiraf: opts.mergiraf, mergirafPath });

  // Drop drivers from an earlier registration whose index no longer exists.
  const stale = tryGit(worktreePath, ['config', '--local', '--name-only', '--get-regexp', '^merge\\.buildd-derived-']);
  if (stale.ok) {
    for (const section of new Set(stale.out.split('\n').filter(Boolean).map(k => k.replace(/\.[^.]+$/, '')))) {
      tryGit(worktreePath, ['config', '--local', '--remove-section', section]);
    }
  }
  for (const [key, value] of plan.config) git(worktreePath, ['config', '--local', key, value]);
  git(worktreePath, ['config', '--local', 'rerere.enabled', 'true']);
  git(worktreePath, ['config', '--local', 'rerere.autoUpdate', 'true']);

  const attributesPath = join(gitPath(worktreePath, '--git-common-dir'), 'info', 'attributes');
  mkdirSync(dirname(attributesPath), { recursive: true });
  const existing = existsSync(attributesPath) ? readFileSync(attributesPath, 'utf-8') : '';
  writeFileSync(attributesPath, replaceManagedBlock(existing, plan.attributes));
  return plan;
}

// ── Merge ────────────────────────────────────────────────────────────────────

export interface DerivedMergeResult {
  /** merged: a merge commit exists with every derived file regenerated. conflicts: merge left in progress. */
  status: 'merged' | 'conflicts' | 'up_to_date' | 'error';
  /** Paths still conflicted after the drivers ran (the agent's work). */
  conflicted: string[];
  /** Regenerate commands already run and committed. */
  regenerated: string[];
  /** Regenerate commands owed once the real conflicts are resolved. */
  pendingRegenerate: string[];
  error?: string;
}

function takePendingCommands(worktreePath: string, rules: NormalizedDerivedFileRule[]): string[] {
  const file = join(gitPath(worktreePath, '--git-dir'), PENDING_FILE);
  if (!existsSync(file)) return [];
  const indices = new Set(readFileSync(file, 'utf-8').split('\n').map(s => Number.parseInt(s, 10)).filter(n => Number.isInteger(n)));
  rmSync(file, { force: true });
  return [...new Set([...indices].sort((a, b) => a - b).map(i => rules[i]?.regenerate).filter((c): c is string => !!c))];
}

function runRegenerate(worktreePath: string, command: string): void {
  execSync(command, { cwd: worktreePath, encoding: 'utf-8', timeout: REGENERATE_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/sh' });
}

/**
 * Merge `baseRef` into the checked-out branch with the drivers in place. Never
 * pushes. On any unexpected failure the merge is aborted and the branch is left
 * exactly as it was, so the agent starts from today's state.
 */
export function mergeBaseWithDerivedFiles(
  worktreePath: string,
  baseRef: string,
  rules: NormalizedDerivedFileRule[],
): DerivedMergeResult {
  const result: DerivedMergeResult = { status: 'error', conflicted: [], regenerated: [], pendingRegenerate: [] };
  const before = tryGit(worktreePath, ['rev-parse', 'HEAD']);
  if (!before.ok) return { ...result, error: before.out };
  // A leftover pending list from an unrelated earlier merge must not trigger commands now.
  takePendingCommands(worktreePath, rules);

  const merge = tryGit(worktreePath, ['merge', '--no-edit', '--no-ff', baseRef]);
  const unmerged = tryGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  const conflicted = unmerged.ok ? unmerged.out.split('\n').filter(Boolean) : [];

  const abort = (error: string): DerivedMergeResult => {
    tryGit(worktreePath, ['merge', '--abort']);
    tryGit(worktreePath, ['reset', '--hard', before.out]);
    takePendingCommands(worktreePath, rules);
    return { ...result, status: 'error', error };
  };

  if (!merge.ok && conflicted.length === 0) return abort(merge.out);

  if (conflicted.length > 0) {
    return { ...result, status: 'conflicts', conflicted, pendingRegenerate: takePendingCommands(worktreePath, rules) };
  }

  const after = tryGit(worktreePath, ['rev-parse', 'HEAD']);
  if (after.ok && after.out === before.out) return { ...result, status: 'up_to_date' };

  const commands = takePendingCommands(worktreePath, rules);
  try {
    for (const command of commands) runRegenerate(worktreePath, command);
  } catch (err) {
    return abort(`regenerate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (commands.length > 0) {
    const add = tryGit(worktreePath, ['add', '-u']);
    const dirty = tryGit(worktreePath, ['diff', '--cached', '--quiet']);
    if (add.ok && !dirty.ok) {
      // Fold the regenerated files into the merge commit itself.
      const amend = tryGit(worktreePath, ['commit', '--amend', '--no-edit', '--no-verify']);
      if (!amend.ok) return abort(`amend failed: ${amend.out}`);
    }
  }
  return { ...result, status: 'merged', regenerated: commands };
}

// ── Task wiring ──────────────────────────────────────────────────────────────

/** A conflict retry that merges its base (not a migration renumber). */
export function isConflictRetryContext(context: Record<string, unknown> | null | undefined): boolean {
  if (!context || typeof context.resumeBranch !== 'string' || !context.resumeBranch) return false;
  const errorType = (context.failureContext as { errorType?: unknown } | undefined)?.errorType;
  return errorType === 'merge_conflict' || errorType === 'semantic_conflict';
}

/** The prompt section telling the agent what the runner already did. Null when there is nothing to say. */
export function formatDerivedMergeNote(result: DerivedMergeResult, baseRef: string): string | null {
  if (result.status === 'merged') {
    const regen = result.regenerated.length
      ? ` Derived files were regenerated with: ${result.regenerated.map(c => `\`${c}\``).join(', ')}.`
      : '';
    return `\n\n## Base already merged\nThe runner merged \`${baseRef}\` into this branch before you started and it merged without conflicts.${regen} ` +
      `Do not merge again. Verify the result (build and the tests that cover the changed files), push the branch, and complete the task.`;
  }
  if (result.status === 'conflicts') {
    const files = result.conflicted.map(f => `- \`${f}\``).join('\n');
    const regen = result.pendingRegenerate.length
      ? `\n\nDerived files were resolved automatically. After resolving the files above, run these from the repo root and stage the result before committing:\n${result.pendingRegenerate.map(c => `- \`${c}\``).join('\n')}`
      : '';
    return `\n\n## Merge in progress\nThe runner started merging \`${baseRef}\` into this branch. Do not abort it or merge again. These files still conflict and need resolving on the merits:\n${files}${regen}`;
  }
  return null;
}


/**
 * Standing guidance for any session in a clone with drivers registered: a merge
 * or rebase the agent runs itself resolves these files by keeping one side, so
 * the generator is owed afterwards.
 */
export function formatDerivedFilesGuidance(rules: NormalizedDerivedFileRule[]): string | null {
  if (rules.length === 0) return null;
  const lines = rules.map(r => `- \`${r.glob}\` → \`${r.regenerate}\``);
  return `\n\n## Derived files\nIn this checkout these files never conflict: a merge or rebase keeps one side whole. ` +
    `After any merge or rebase that touched one, run its command from the repo root and commit the result:\n${lines.join('\n')}`;
}
