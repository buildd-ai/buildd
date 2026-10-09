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
 * the regenerated files in it, which `finishDerivedMerge` verifies and pushes so
 * no agent session runs at all; mixed ones leave the merge in progress with only
 * the real conflicts unresolved, and the owed commands for the agent to run.
 *
 * Deliberately no "concatenate both sides" rule (`merge=union`): replayed
 * against real resolutions it duplicated changes the base already carried more
 * often than it was right. Real text conflicts stay with the agent.
 */

import { exec, execFileSync, execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { promisify } from 'util';
import type { NormalizedDerivedFileRule } from '@buildd/shared';

export { normalizeDerivedFiles, type NormalizedDerivedFileRule } from '@buildd/shared';

const pexec = promisify(exec);

const REGENERATE_TIMEOUT_MS = 5 * 60_000;
/**
 * A base merge with structural drivers on a large tree takes well over a
 * minute (a replayed buildd retry took ~45s on a laptop and was killed by the
 * old 30s cap). Killed mid-merge, git records no conflicts and the merge is lost.
 */
const MERGE_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 15 * 60_000;
const PUSH_TIMEOUT_MS = 2 * 60_000;
const PENDING_FILE = 'buildd-derived-pending';
const BLOCK_START = '# >>> buildd derived files (managed by the buildd runner) >>>';
const BLOCK_END = '# <<< buildd derived files <<<';

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

  // git's own merge temp files: a merge killed mid-way (timeout) leaves them,
  // and a driver that outlives git can write one late. Never committable.
  const excludePath = join(gitPath(worktreePath, '--git-common-dir'), 'info', 'exclude');
  mkdirSync(dirname(excludePath), { recursive: true });
  const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
  writeFileSync(excludePath, replaceManagedBlock(exclude, plan.config.length > 0 ? ['.merge_file_*'] : []));

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
  /**
   * Files mergiraf resolved structurally during this merge. Real code nobody
   * has reviewed: a merge with any is never finished without an agent.
   */
  structurallyResolved: string[];
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

/** Delete git's merge temp files (`.merge_file_*`) a killed merge left in the tree. */
function removeMergeTempFiles(worktreePath: string): void {
  const left = tryGit(worktreePath, ['ls-files', '--others', '--ignored', '--exclude=.merge_file_*']);
  for (const rel of left.ok ? left.out.split('\n').filter(Boolean) : []) {
    if (/(^|\/)\.merge_file_[^/]+$/.test(rel)) rmSync(join(worktreePath, rel), { force: true });
  }
}

/**
 * The paths mergiraf says it solved. It prints one line per file to stderr
 * ("INFO Mergiraf: Solved N conflict(s). Review with: mergiraf review
 * <basename>_<id>"), naming only the basename, so map each back to the files
 * this merge changed. Every same-named match counts: over-reporting only sends
 * a merge to an agent.
 */
function mergirafResolvedPaths(worktreePath: string, before: string, stderr: string): string[] {
  const names = [...stderr.matchAll(/mergiraf review (\S+)_[A-Za-z0-9]+\s*$/gm)].map(m => m[1]);
  if (names.length === 0) return [];
  const changed = tryGit(worktreePath, ['diff', '--name-only', before]);
  const paths = changed.ok ? changed.out.split('\n').filter(Boolean) : [];
  const out = new Set<string>();
  for (const name of names) {
    const hits = paths.filter(p => p === name || p.endsWith(`/${name}`));
    // Not found among the changes: still record it, by name.
    for (const hit of hits.length ? hits : [name]) out.add(hit);
  }
  return [...out].sort();
}

const IMPORT_LINE = /^import\s[^;]*;?\s*$/;

/**
 * Drop exact repeats of a top-level single-line `import` statement. A semantic
 * (mergiraf) merge can keep the same import that both sides added at different
 * positions; the first occurrence wins, so both sides' other changes survive.
 */
export function dedupeImportLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (IMPORT_LINE.test(line) && line.startsWith('import')) {
      const key = line.trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  return out.join('\n');
}

const DEDUPE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/** Dedupe imports in files mergiraf resolved; returns the paths actually changed. */
function dedupeResolvedImports(worktreePath: string, paths: string[]): string[] {
  const changed: string[] = [];
  for (const rel of paths) {
    if (!DEDUPE_EXT.test(rel)) continue;
    const file = join(worktreePath, rel);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf-8');
    // A file still carrying conflict markers is the agent's to resolve.
    if (/^(<{7}|>{7}) /m.test(before)) continue;
    const after = dedupeImportLines(before);
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(rel);
    }
  }
  return changed;
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
  opts: { timeoutMs?: number } = {},
): DerivedMergeResult {
  const result: DerivedMergeResult = { status: 'error', conflicted: [], regenerated: [], pendingRegenerate: [], structurallyResolved: [] };
  const before = tryGit(worktreePath, ['rev-parse', 'HEAD']);
  if (!before.ok) return { ...result, error: before.out };
  // A leftover pending list from an unrelated earlier merge must not trigger commands now.
  takePendingCommands(worktreePath, rules);

  const timeoutMs = opts.timeoutMs ?? MERGE_TIMEOUT_MS;
  const run = spawnSync('git', ['merge', '--no-edit', '--no-ff', baseRef], {
    cwd: worktreePath, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = run.error?.message.includes('ETIMEDOUT') || run.signal === 'SIGTERM';
  const merge = {
    ok: !run.error && run.status === 0,
    out: timedOut
      ? `git merge timed out after ${Math.round(timeoutMs / 1000)}s`
      : `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() || String(run.error?.message ?? `exit ${run.status}`),
  };
  const unmerged = tryGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  const conflicted = timedOut || !unmerged.ok ? [] : unmerged.out.split('\n').filter(Boolean);
  const structurallyResolved = timedOut ? [] : mergirafResolvedPaths(worktreePath, before.out, run.stderr ?? '');

  const abort = (error: string): DerivedMergeResult => {
    tryGit(worktreePath, ['merge', '--abort']);
    tryGit(worktreePath, ['reset', '--hard', before.out]);
    removeMergeTempFiles(worktreePath);
    takePendingCommands(worktreePath, rules);
    return { ...result, status: 'error', error };
  };

  if (!merge.ok && conflicted.length === 0) return abort(merge.out);

  const dedupedImports = dedupeResolvedImports(worktreePath, structurallyResolved.filter(p => !conflicted.includes(p)));

  if (conflicted.length > 0) {
    return { ...result, status: 'conflicts', conflicted, structurallyResolved, pendingRegenerate: takePendingCommands(worktreePath, rules) };
  }

  const after = tryGit(worktreePath, ['rev-parse', 'HEAD']);
  if (after.ok && after.out === before.out) return { ...result, status: 'up_to_date' };

  const commands = takePendingCommands(worktreePath, rules);
  try {
    for (const command of commands) runRegenerate(worktreePath, command);
  } catch (err) {
    return abort(`regenerate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (commands.length > 0 || dedupedImports.length > 0) {
    const add = tryGit(worktreePath, ['add', '-u']);
    const dirty = tryGit(worktreePath, ['diff', '--cached', '--quiet']);
    if (add.ok && !dirty.ok) {
      // Fold the regenerated files into the merge commit itself.
      const amend = tryGit(worktreePath, ['commit', '--amend', '--no-edit', '--no-verify']);
      if (!amend.ok) return abort(`amend failed: ${amend.out}`);
    }
  }
  return { ...result, status: 'merged', regenerated: commands, structurallyResolved };
}

// ── Finish without an agent ──────────────────────────────────────────────────

export interface DerivedFinishResult {
  /** pushed: the merge commit is on the remote branch. Anything else: nothing was pushed. */
  status: 'pushed' | 'verify_failed' | 'push_failed';
  /** The verification command that ran, or null when there was none. */
  verification: string | null;
  headSha?: string;
  error?: string;
}

/** The workspace verification a mechanical finish runs: the task's `verificationCommand`, if any. */
export function derivedMergeVerificationCommand(context: Record<string, unknown> | null | undefined): string | null {
  const command = context?.verificationCommand;
  return typeof command === 'string' && command.trim() ? command.trim() : null;
}

function lastLines(text: string, n = 20): string {
  return text.trim().split('\n').slice(-n).join('\n');
}

/**
 * Verify and push a merge `mergeBaseWithDerivedFiles` finished, so a
 * derived-only conflict retry never needs an agent. Never force-pushes: a
 * branch that moved on the remote is reported, and the agent takes over.
 */
export async function finishDerivedMerge(
  worktreePath: string,
  branch: string,
  opts: { verificationCommand: string | null; verifyTimeoutMs?: number },
): Promise<DerivedFinishResult> {
  const verification = opts.verificationCommand;
  if (verification) {
    try {
      await pexec(verification, {
        cwd: worktreePath,
        timeout: opts.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
        shell: '/bin/sh',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = lastLines(`${e.stdout ?? ''}\n${e.stderr ?? ''}`) || String(e.message ?? err);
      return { status: 'verify_failed', verification, error: out };
    }
    // What gets pushed must be what was verified.
    const dirty = tryGit(worktreePath, ['status', '--porcelain', '--untracked-files=no']);
    if (!dirty.ok || dirty.out) {
      return { status: 'verify_failed', verification, error: `verification changed tracked files: ${dirty.out}` };
    }
  }
  const head = tryGit(worktreePath, ['rev-parse', 'HEAD']);
  if (!head.ok) return { status: 'push_failed', verification, error: head.out };
  try {
    git(worktreePath, ['push', '--no-verify', '-q', 'origin', `HEAD:refs/heads/${branch}`], PUSH_TIMEOUT_MS);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { status: 'push_failed', verification, error: lastLines(e.stderr ?? '') || String(e.message ?? err) };
  }
  return { status: 'pushed', verification, headSha: head.out };
}

// ── Task wiring ──────────────────────────────────────────────────────────────

/** A conflict retry that merges its base (not a migration renumber). */
export function isConflictRetryContext(context: Record<string, unknown> | null | undefined): boolean {
  if (!context || typeof context.resumeBranch !== 'string' || !context.resumeBranch) return false;
  const errorType = (context.failureContext as { errorType?: unknown } | undefined)?.errorType;
  return errorType === 'merge_conflict' || errorType === 'semantic_conflict';
}

/**
 * Whether the runner may verify and push this merge itself, with no agent:
 * only a clean merge in which nothing but derived files needed resolving. A
 * file mergiraf resolved is code nobody has reviewed, so an agent reviews it.
 */
export function canFinishWithoutAgent(result: DerivedMergeResult): boolean {
  return result.status === 'merged' && result.structurallyResolved.length === 0;
}

/**
 * One line per pre-merge, for the worker's milestones (which reach the
 * server). Always starts "Pre-merge:" and names any file mergiraf resolved, so
 * a report can count outcomes and structural resolutions from task records.
 */
export function formatPreMergeMilestone(result: DerivedMergeResult): string {
  const mergiraf = result.structurallyResolved.length
    ? `; mergiraf resolved ${result.structurallyResolved.length}: ${result.structurallyResolved.join(', ')}`
    : '';
  const regen = result.regenerated.length ? `; regenerated ${result.regenerated.length} derived file command(s)` : '';
  switch (result.status) {
    case 'merged': return `Pre-merge: base merged by the runner${regen}${mergiraf}`;
    case 'conflicts': return `Pre-merge: ${result.conflicted.length} file(s) left for the agent${mergiraf}`;
    case 'up_to_date': return 'Pre-merge: already up to date with the base';
    default: return `Pre-merge: failed, agent merges instead (${(result.error ?? 'unknown error').split('\n')[0].slice(0, 160)})`;
  }
}

/** The prompt section telling the agent what the runner already did. Null when there is nothing to say. */
export function formatDerivedMergeNote(result: DerivedMergeResult, baseRef: string): string | null {
  if (result.status === 'merged') {
    const regen = result.regenerated.length
      ? ` Derived files were regenerated with: ${result.regenerated.map(c => `\`${c}\``).join(', ')}.`
      : '';
    const structural = result.structurallyResolved.length
      ? ` mergiraf resolved conflicts structurally in: ${result.structurallyResolved.map(f => `\`${f}\``).join(', ')}. ` +
        `Nobody has reviewed those resolutions: read each one (\`git diff HEAD^1 -- <file>\` and \`git diff HEAD^2 -- <file>\`) and fix anything that lost a change from either side.`
      : '';
    return `\n\n## Base already merged\nThe runner merged \`${baseRef}\` into this branch before you started and it merged without conflicts.${regen}${structural} ` +
      `Do not merge again. Verify the result (build and the tests that cover the changed files), push the branch, and complete the task.`;
  }
  if (result.status === 'conflicts') {
    const files = result.conflicted.map(f => `- \`${f}\``).join('\n');
    const regen = result.pendingRegenerate.length
      ? `\n\nDerived files were resolved automatically. After resolving the files above, run these from the repo root and stage the result before committing:\n${result.pendingRegenerate.map(c => `- \`${c}\``).join('\n')}`
      : '';
    const structural = result.structurallyResolved.length
      ? `\n\nmergiraf already resolved these structurally; review them too before committing: ${result.structurallyResolved.map(f => `\`${f}\``).join(', ')}.`
      : '';
    return `\n\n## Merge in progress\nThe runner started merging \`${baseRef}\` into this branch. Do not abort it or merge again. These files still conflict and need resolving on the merits:\n${files}${regen}${structural}`;
  }
  return null;
}

/** The completion summary for a conflict retry the runner finished itself. */
export function formatDerivedMergeSummary(merge: DerivedMergeResult, baseRef: string, finish: DerivedFinishResult): string {
  const regen = merge.regenerated.length
    ? ` Derived files regenerated with: ${merge.regenerated.map(c => `\`${c}\``).join(', ')}.`
    : ' No derived file needed regenerating.';
  const verified = finish.verification
    ? ` Verified with \`${finish.verification}\`.`
    : ' No verification command is set for this task, so none ran; CI checks the pushed branch.';
  return `Merged \`${baseRef}\` into the branch and pushed it${finish.headSha ? ` (${finish.headSha.slice(0, 12)})` : ''}; ` +
    `every conflict was in a derived file, so the runner finished this retry with no agent session.${regen}${verified}`;
}

/** Appended to the merge note when the runner could not finish on its own. */
export function formatDerivedFinishFallback(finish: DerivedFinishResult): string {
  const why = finish.status === 'verify_failed'
    ? `Verification${finish.verification ? ` (\`${finish.verification}\`)` : ''} failed`
    : 'The push failed';
  return `\n\nThe runner tried to finish this without you and stopped: ${why}, so the merge is not pushed. ` +
    `Output:\n\`\`\`\n${(finish.error ?? '').slice(0, 2000)}\n\`\`\``;
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
