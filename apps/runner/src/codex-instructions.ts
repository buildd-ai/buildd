import { readFile, writeFile, rm, lstat, realpath, symlink, appendFile, mkdir } from 'fs/promises';
import { execFileSync } from 'child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

/**
 * Codex role / skills / context delivery (Phase 2A).
 *
 * The Claude backend gets its persona + skills + project context for free via
 * the SDK's `systemPrompt` preset+append, `settingSources` (loads CLAUDE.md and
 * user skills from disk), and the `Skill(slug)` tool allowlist. None of that
 * exists for Codex:
 *   - `@openai/codex-sdk@0.44.0` `ThreadOptions` is ONLY
 *     `{model, sandboxMode, workingDirectory, skipGitRepoCheck}` — there is no
 *     `instructions` / `baseInstructions` / system-prompt option.
 *   - Codex has no `Skill` tool, so skill content cannot be *referenced*; it must
 *     be *inlined* into the instructions the model sees.
 *
 * Codex's native instruction channel is `AGENTS.md`, which it reads from the
 * working directory. We compose a single instruction document and write it into
 * the repo cwd as `AGENTS.md`.
 *
 * Why AGENTS.md over a prompt preamble: the worker run is multi-turn
 * (output-requirement nudges and steering follow-ups all run additional turns
 * on the same thread). A prompt preamble would only be attached to the
 * *first* turn's input string; AGENTS.md is re-read by Codex on every turn,
 * so the persona + skills persist for the whole session. (We still prepend a
 * one-line pointer to the prompt itself — see workers.ts.)
 */

export const BUILDD_AGENTS_BEGIN = '<!-- BEGIN buildd agent instructions (auto-generated; do not edit) -->';
export const BUILDD_AGENTS_END = '<!-- END buildd agent instructions -->';

const AGENTS_FILENAME = 'AGENTS.md';

export interface CodexSkillInput {
  slug: string;
  name: string;
  content: string;
}

export interface BuildCodexInstructionDocInput {
  /** Role persona / system-prompt text (the role's CLAUDE.md, the same content
   *  Claude loads via settingSources). Optional — a task may have no role. */
  rolePersona?: string;
  /** Resolved skill bundles to inline (Codex has no Skill tool). */
  skillBundles: CodexSkillInput[];
  /** Project CLAUDE.md / AGENTS.md content, included when `useClaudeMd` is set. */
  projectInstructions?: string;
}

/**
 * Compose the Codex instruction document: role persona + inlined skill content
 * + optional project instructions.
 *
 * Pure and unit-testable. The returned string is the *body* that
 * `writeCodexAgentsMd` wraps in the delimited buildd section.
 */
export function buildCodexInstructionDoc(input: BuildCodexInstructionDocInput): string {
  const sections: string[] = [];

  const persona = input.rolePersona?.trim();
  if (persona) {
    sections.push(`# Your Role\n\n${persona}`);
  }

  const skills = (input.skillBundles || []).filter((s) => s && s.content && s.content.trim());
  if (skills.length > 0) {
    const skillBlocks = skills
      .map((s) => `## Skill: ${s.name || s.slug}\n\n${s.content.trim()}`)
      .join('\n\n');
    // Note: deliberately NO "invoke with the Skill tool" — Codex has no Skill
    // tool, so the content is inlined as standing instructions.
    sections.push(
      `# Skills\n\nThe following skills apply to this task. Their full instructions are inlined below — follow them directly (there is no separate skill tool to invoke).\n\n${skillBlocks}`,
    );
  }

  const project = input.projectInstructions?.trim();
  if (project) {
    sections.push(`# Project Instructions\n\n${project}`);
  }

  return sections.join('\n\n');
}

export interface AgentsMdWriteResult {
  /** Absolute path to the AGENTS.md that was written. */
  path: string;
  /** Checkout the file lives in. */
  cwd: string;
  /** Whether an AGENTS.md already existed before we wrote (drives cleanup mode). */
  existed: boolean;
  /** Content the repo owns, with any buildd block stripped (never the raw file,
   *  which after a crash still holds the block). Used only when untracked. */
  originalContent?: string;
  /** Tracked path: what the index holds (git mode and blob), the source of truth
   *  for restore. Mode 120000 is a symlink whose blob is its target. */
  indexMode?: string;
  indexBlob?: string;
  /** Untracked path: the exclude line this run appended (never one already there). */
  excludeFile?: string;
  excludeLine?: string;
  /** Nested writes on the same path share one handle; only the last restore acts. */
  holders: number;
}

/** Live handles by path. The closing turn re-enters startSession on the same
 *  cwd while the outer run still owns the swapped file; the nested write must
 *  not record that swapped file as the "original". */
const active = new Map<string, AgentsMdWriteResult>();
/** Exclude lines added by live runs, by exclude file (linked worktrees share one). */
const excludeHolders = new Map<string, number>();

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
  } catch {
    return null;
  }
}

function indexEntry(cwd: string): { mode: string; blob: string } | null {
  const out = git(cwd, ['ls-files', '-s', '--', AGENTS_FILENAME]);
  const m = out?.match(/^(\d+) ([0-9a-f]+) \d\t/);
  return m ? { mode: m[1], blob: m[2] } : null;
}

/**
 * Strip any previously-written buildd section (delimited) from `content`.
 * Leaves surrounding repo content untouched. Idempotent.
 */
function stripBuilddSection(content: string): string {
  const begin = content.indexOf(BUILDD_AGENTS_BEGIN);
  if (begin === -1) return content;
  const endMarker = content.indexOf(BUILDD_AGENTS_END, begin);
  if (endMarker === -1) {
    // Malformed (no end marker) — drop from begin to EOF defensively.
    return content.slice(0, begin).replace(/\n+$/, '\n');
  }
  const after = content.slice(endMarker + BUILDD_AGENTS_END.length);
  return (content.slice(0, begin) + after).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the instruction `body` into the repo's AGENTS.md as a delimited buildd
 * section, keeping it out of every commit (a headless run once shipped the block
 * into CLAUDE.md through the AGENTS.md symlink).
 *
 * - Never writes through a symlink: the link is replaced by a regular file for
 *   the run (its target, CLAUDE.md, is tracked).
 * - A tracked path is hidden with skip-worktree; an untracked one is added to the
 *   checkout's info/exclude. Restore is driven by the git index, not lstat, so a
 *   crashed earlier run (regular file holding the block, stale flag) heals.
 * - Re-entrant: a nested write on a path with a live handle reuses it.
 */
export async function writeCodexAgentsMd(cwd: string, body: string): Promise<AgentsMdWriteResult> {
  const path = join(cwd, AGENTS_FILENAME);
  const section = `${BUILDD_AGENTS_BEGIN}\n${body}\n${BUILDD_AGENTS_END}\n`;

  const live = active.get(path);
  if (live) {
    live.holders++;
    const cur = await readFile(path, 'utf-8').catch(() => '');
    const base = stripBuilddSection(cur).replace(/\s+$/, '');
    await writeFile(path, base.length > 0 ? `${base}\n\n${section}` : section);
    return live;
  }

  const existed = await pathExists(path);
  const result: AgentsMdWriteResult = { path, cwd, existed, holders: 1 };
  const inRepo = git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';

  let raw = '';
  if (existed) raw = await readFile(path, 'utf-8').catch(() => '');
  result.originalContent = existed ? stripBuilddSection(raw) : undefined;

  if (inRepo) {
    const entry = indexEntry(cwd);
    if (entry) {
      result.indexMode = entry.mode;
      result.indexBlob = entry.blob;
      git(cwd, ['update-index', '--skip-worktree', '--', AGENTS_FILENAME]);
    } else {
      const rel = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
      if (rel) {
        const abs = isAbsolute(rel) ? rel : resolve(cwd, rel);
        // Canonical, so two linked worktrees reaching it by different spellings share one key.
        const file = join(await realpath(dirname(abs)).catch(() => dirname(abs)), basename(abs));
        const line = `/${AGENTS_FILENAME}`;
        const cur = await readFile(file, 'utf-8').catch(() => '');
        const held = excludeHolders.get(file) ?? 0;
        if (held > 0) {
          excludeHolders.set(file, held + 1);
          result.excludeFile = file;
          result.excludeLine = line;
        } else if (!cur.split('\n').includes(line)) {
          try {
            await mkdir(dirname(file), { recursive: true });
            await appendFile(file, `${cur === '' || cur.endsWith('\n') ? '' : '\n'}${line}\n`);
            excludeHolders.set(file, 1);
            result.excludeFile = file;
            result.excludeLine = line;
          } catch {
            // best-effort
          }
        }
      }
    }
  }

  // Never write through a symlink: its target is a tracked file.
  const st = await lstat(path).catch(() => null);
  if (st?.isSymbolicLink()) {
    // The linked file's own text is the repo content to build on.
    result.originalContent = stripBuilddSection(await readFile(path, 'utf-8').catch(() => ''));
    await rm(path, { force: true });
  }
  const base = (result.originalContent ?? '').replace(/\s+$/, '');
  await writeFile(path, base.length > 0 ? `${base}\n\n${section}` : section);

  active.set(path, result);
  return result;
}

/**
 * Undo `writeCodexAgentsMd`. Safe to call unconditionally and more than once.
 * Tracked: put back exactly what the index holds (link or file) and clear the
 * flag. Untracked: delete what we created, or restore the repo's own content
 * with any buildd block stripped. The exclude line is removed only if this run
 * added it and no other run still needs it.
 */
export async function restoreCodexAgentsMd(_cwd: string, result: AgentsMdWriteResult): Promise<void> {
  if (active.get(result.path) === result) {
    result.holders--;
    if (result.holders > 0) return;
    active.delete(result.path);
  } else if (result.holders <= 0) {
    return; // already restored
  } else {
    result.holders = 0;
  }
  const { path, cwd, existed, originalContent, indexMode, indexBlob } = result;
  try {
    if (indexMode !== undefined && indexBlob !== undefined) {
      await rm(path, { force: true });
      const content = git(cwd, ['cat-file', 'blob', indexBlob]);
      if (indexMode === '120000' && content !== null) await symlink(content, path);
      else if (content !== null) await writeFile(path, content === '' ? '' : `${content}\n`);
      git(cwd, ['update-index', '--no-skip-worktree', '--', AGENTS_FILENAME]);
    } else if (!existed) {
      await rm(path, { force: true });
    } else if (originalContent !== undefined) {
      await writeFile(path, originalContent);
    }
  } catch (err) {
    // Best-effort cleanup — never let restore failures break the run's finally.
    console.error(`[codex-instructions] Failed to restore ${path}:`, err);
  }
  await releaseExclude(result);
}

async function releaseExclude(result: AgentsMdWriteResult): Promise<void> {
  const { excludeFile: file, excludeLine: line } = result;
  if (!file || !line) return;
  const held = (excludeHolders.get(file) ?? 1) - 1;
  if (held > 0) {
    excludeHolders.set(file, held);
    return;
  }
  excludeHolders.delete(file);
  try {
    const cur = await readFile(file, 'utf-8');
    const i = cur.lastIndexOf(`\n${line}\n`);
    const next = i >= 0 ? cur.slice(0, i + 1) + cur.slice(i + line.length + 2) : cur.startsWith(`${line}\n`) ? cur.slice(line.length + 1) : cur;
    await writeFile(file, next);
  } catch {
    // best-effort
  }
}
