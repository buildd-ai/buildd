/**
 * Keep a worker acting in its OWN worktree, not in the primary clone.
 *
 * Worktrees are created at `<primary>/.buildd-worktrees/<slug>` — nested INSIDE
 * the clone every worker on that repo shares. That makes "the repo root"
 * ambiguous to an agent: the primary clone is an ancestor of its cwd, the CLI
 * used to load the primary's CLAUDE.md under its own path, and `git worktree
 * list` / the worktree's `.git` file name it. Agents were seen prefixing
 * commands with `cd <primary> && …` and editing, testing, stashing and
 * committing there — the shared checkout drifted onto a stale branch holding
 * unpushed commits, stashes, and several tasks' uncommitted edits, and
 * commits there swept up other workers' leftovers.
 *
 * This module is the policy half of a PreToolUse guard (hook-factory.ts):
 *   - Bash that changes directory into the primary clone or a sibling worktree
 *     (`cd`, `pushd`, `git -C`, `--cwd`, …), or runs while the shell is already
 *     there, is denied.
 *   - Edit/Write/MultiEdit/NotebookEdit under the primary clone but outside the
 *     worker's own worktree is denied.
 *   - READS are not denied here: reading a file elsewhere does not mutate a
 *     shared checkout (the Tier-2 read-jail handles sibling-worktree reads).
 *
 * It is a best-effort parser, not a sandbox. A target it cannot resolve
 * statically (`cd "$DIR"`, `cd -`, `eval`, `bash -c`) fails open — the prompt
 * and CLAUDE.md exclusion remove the reason to go there; this catches the
 * literal pattern that was observed. Kernel-level confinement is bwrap's job.
 */

import { homedir } from 'os';
import { isAbsolute, join, normalize, resolve as resolvePath, sep } from 'path';
import { WORKTREE_DIR_MARKER } from './worktree-utils';

export interface WorktreeScope {
  /** The worker's own worktree (session cwd). */
  worktreePath: string;
  /** The primary clone the worktree is nested inside. */
  primaryPath: string;
}

export type WorktreePathClass = 'own' | 'primary' | 'other_worktree' | 'outside';

function clean(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

function under(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Where an absolute path sits relative to the worker's worktree and the primary clone. */
export function classifyWorktreePath(absPath: string, scope: WorktreeScope): WorktreePathClass {
  const abs = clean(resolvePath(absPath));
  const own = clean(scope.worktreePath);
  const primary = clean(scope.primaryPath);
  if (under(abs, own)) return 'own';
  if (!under(abs, primary)) return 'outside';
  const worktrees = join(primary, WORKTREE_DIR_MARKER);
  if (abs.startsWith(worktrees + sep)) return 'other_worktree';
  return 'primary';
}

function isForbidden(c: WorktreePathClass): boolean {
  return c === 'primary' || c === 'other_worktree';
}

function denyMessage(target: string, cls: WorktreePathClass, scope: WorktreeScope, action: string): string {
  const what = cls === 'other_worktree' ? "another worker's worktree" : 'the shared primary clone, not your worktree';
  return (
    `Blocked: ${action} ${target}, which is ${what}. ` +
    `Your worktree is ${scope.worktreePath} — run commands, tests and git there ` +
    `(\`cd ${scope.worktreePath}\`) and edit files under it. Other workers share the checkout ` +
    `that contains it; changing directory into, editing, testing, stashing or committing there ` +
    `corrupts their work. Reading files elsewhere is still allowed.`
  );
}

// ── Shell tokenizing (just enough to find directory changes) ──────────────

interface Word { text: string; dynamic: boolean }
type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

/**
 * Split a shell command into words and control operators, honouring quotes and
 * backslash escapes. A word that contains unquoted/double-quoted `$` or a
 * backtick is marked dynamic — its value is not knowable statically. Heredoc
 * bodies are skipped: they are data (a script being written, a message), and
 * simulating their lines as commands denied ordinary work like writing a
 * script that contains `cd ..`.
 */
function tokenize(command: string): Token[] {
  const out: Token[] = [];
  let buf = '';
  let dynamic = false;
  let inWord = false;
  const heredocs: Array<{ delim: string; stripTabs: boolean }> = [];
  const flush = () => {
    if (inWord) out.push({ kind: 'word', word: { text: buf, dynamic } });
    buf = ''; dynamic = false; inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') { i++; continue; }
      buf += command[++i]; inWord = true; continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      buf += command.slice(i + 1, stop); inWord = true; i = stop; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) { buf += command[j + 1]; j += 2; continue; }
        if (command[j] === '$' || command[j] === '`') dynamic = true;
        buf += command[j++];
      }
      inWord = true; i = j; continue;
    }
    if (ch === '$' || ch === '`') { dynamic = true; buf += ch; inWord = true; continue; }
    if (ch === '<' && command.startsWith('<<<', i)) { buf += '<<<'; inWord = true; i += 2; continue; }
    if (ch === '<' && command[i + 1] === '<') {
      // Heredoc: remember the terminator; the body (after the next newline) is data.
      flush();
      let j = i + 2;
      const stripTabs = command[j] === '-';
      if (stripTabs) j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      let delim = '';
      while (j < command.length && !/[\s;&|()<>]/.test(command[j])) {
        const q = command[j];
        if (q === "'" || q === '"') {
          const end = command.indexOf(q, j + 1);
          const stop = end === -1 ? command.length : end;
          delim += command.slice(j + 1, stop); j = stop + 1; continue;
        }
        if (q === '\\' && j + 1 < command.length) { delim += command[j + 1]; j += 2; continue; }
        delim += q; j++;
      }
      if (delim) heredocs.push({ delim, stripTabs });
      i = j - 1; continue;
    }
    if (ch === ' ' || ch === '\t') { flush(); continue; }
    if (ch === '\n' && heredocs.length) {
      flush(); out.push({ kind: 'op', op: ch });
      let pos = i + 1;
      for (const h of heredocs) {
        while (pos < command.length) {
          const nl = command.indexOf('\n', pos);
          const end = nl === -1 ? command.length : nl;
          const line = command.slice(pos, end);
          pos = end + 1;
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      heredocs.length = 0;
      i = pos - 1; continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') { flush(); out.push({ kind: 'op', op: ch }); continue; }
    if (ch === '&' || ch === '|') {
      flush();
      const two = command[i + 1] === ch;
      out.push({ kind: 'op', op: two ? ch + ch : ch });
      if (two) i++;
      continue;
    }
    if (ch === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1; continue;
    }
    buf += ch; inWord = true;
  }
  flush();
  return out;
}

/** Flags that take a directory and run the command there. */
function dirFlagTargets(cmd: string, args: Word[]): Word[] {
  const found: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    const next = args[i + 1];
    if ((cmd === 'git' || cmd === 'make' || cmd === 'pnpm' || cmd === 'tar') && t === '-C' && next) found.push(next);
    else if ((t === '--cwd' || t === '--dir' || t === '--prefix' || t === '--work-tree' || t === '--directory') && next) found.push(next);
    else {
      const m = /^--(cwd|dir|prefix|work-tree|directory)=(.+)$/.exec(t);
      if (m) found.push({ text: m[2], dynamic: args[i].dynamic });
    }
  }
  return found;
}

/**
 * If `command` would run anything in the primary clone or a sibling worktree,
 * return the denial message; otherwise null.
 *
 * `cwd` is the shell's current directory (the hook input's `cwd`), defaulting
 * to the worktree. Directory changes are simulated left to right; subshells
 * restore the directory on `)`.
 */
export function findWorktreeEscape(
  command: string,
  scope: WorktreeScope & { cwd?: string },
): string | null {
  const tokens = tokenize(command);
  let cur: string | undefined = clean(scope.cwd || scope.worktreePath);
  const stack: Array<string | undefined> = [];
  let words: Word[] = [];

  const resolveTarget = (w: Word): string | undefined => {
    if (w.dynamic) return undefined;
    const p = expandTilde(w.text);
    if (isAbsolute(p)) return clean(p);
    return cur === undefined ? undefined : clean(resolvePath(cur, p));
  };

  const runSegment = (): string | null => {
    const seg = words;
    words = [];
    let i = 0;
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i].text)) i++;
    if (i >= seg.length) return null;
    const cmd = seg[i].text.split('/').pop() ?? seg[i].text;
    const args = seg.slice(i + 1);

    if (cmd === 'cd' || cmd === 'pushd') {
      const target = args.find(a => !/^-[LPe@]+$/.test(a.text));
      if (!target) { cur = clean(homedir()); return null; }
      if (target.text === '-' || /^[+-]\d+$/.test(target.text)) { cur = undefined; return null; }
      cur = resolveTarget(target);
      if (cur === undefined) return null;
      const cls = classifyWorktreePath(cur, scope);
      return isForbidden(cls) ? denyMessage(cur, cls, scope, 'this command changes directory to') : null;
    }
    if (cmd === 'popd') { cur = undefined; return null; }

    if (cur !== undefined) {
      const cls = classifyWorktreePath(cur, scope);
      if (isForbidden(cls)) return denyMessage(cur, cls, scope, 'this command would run in');
    }
    for (const w of dirFlagTargets(cmd, args)) {
      const target = resolveTarget(w);
      if (target === undefined) continue;
      const cls = classifyWorktreePath(target, scope);
      if (isForbidden(cls)) return denyMessage(target, cls, scope, `\`${cmd}\` is pointed at`);
    }
    return null;
  };

  for (const t of tokens) {
    if (t.kind === 'word') { words.push(t.word); continue; }
    const hit = runSegment();
    if (hit) return hit;
    if (t.op === '(') stack.push(cur);
    else if (t.op === ')') cur = stack.length ? stack.pop() : cur;
  }
  return runSegment();
}

/**
 * If writing `rawPath` would modify the primary clone or a sibling worktree,
 * return the denial message; otherwise null. Relative paths resolve against
 * the worktree.
 */
export function findWriteEscape(rawPath: string, scope: WorktreeScope): string | null {
  const p = expandTilde(rawPath);
  const abs = isAbsolute(p) ? p : resolvePath(scope.worktreePath, p);
  const cls = classifyWorktreePath(abs, scope);
  return isForbidden(cls) ? denyMessage(clean(abs), cls, scope, 'this edit targets') : null;
}

// ── Primary clone drift ───────────────────────────────────────────────────

export interface PrimaryCloneState {
  /** Checked-out branch; 'HEAD' when detached; undefined when the probe failed. */
  branch: string | undefined;
  expectedBranch: string;
  dirtyEntries: number;
  stashes: number;
}

/**
 * A loud, human-readable warning when the primary clone is not the pristine
 * base it should be, or null when it is. Never acted on automatically: a
 * dirty primary may hold someone's only copy of their work.
 */
export function describePrimaryCloneDrift(s: PrimaryCloneState): string | null {
  const problems: string[] = [];
  if (s.branch !== undefined && s.branch !== s.expectedBranch) {
    problems.push(s.branch === 'HEAD'
      ? `HEAD is detached (expected ${s.expectedBranch})`
      : `on branch ${s.branch} (expected ${s.expectedBranch})`);
  }
  if (s.dirtyEntries > 0) problems.push(`${s.dirtyEntries} uncommitted change${s.dirtyEntries === 1 ? '' : 's'}`);
  if (s.stashes > 0) problems.push(`${s.stashes} stash${s.stashes === 1 ? '' : 'es'}`);
  if (problems.length === 0) return null;
  return (
    `PRIMARY CLONE DRIFT: the shared clone is ${problems.join(', ')}. ` +
    `Workers should only ever touch their own worktree; something has been working in the ` +
    `shared checkout. Not auto-reset (it may hold unpushed work) — inspect and clean it by hand.`
  );
}
