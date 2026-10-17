import { readFile, writeFile, rm, access, lstat, readlink, symlink, appendFile, mkdir } from 'fs/promises';
import { execFileSync } from 'child_process';
import { dirname, isAbsolute, join, resolve } from 'path';

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
  /** Whether an AGENTS.md already existed before we wrote (drives cleanup mode). */
  existed: boolean;
  /** The original file content when it pre-existed (restored verbatim on cleanup). */
  originalContent?: string;
  /** Set when AGENTS.md was a symlink (this repo links it to CLAUDE.md). Writing
   *  through it edits the link's target, a tracked file, so we replace the link
   *  with a regular file for the run and put the link back on cleanup. */
  symlinkTarget?: string;
  /** Tracked path hidden from `git add`/`commit -a` for the run (skip-worktree). */
  skipWorktree?: boolean;
  /** Untracked path added to the checkout's info/exclude for the run. */
  excludeLine?: string;
  excludeFile?: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Keep the instruction file out of every commit. The block is for the agent to
 * read, never to ship (a headless run once committed the whole role block into
 * CLAUDE.md through the AGENTS.md symlink). A tracked path is hidden with
 * skip-worktree; an untracked one is excluded via the checkout's info/exclude.
 * Best-effort: not a git checkout means nothing to protect.
 */
function hideFromGit(cwd: string, result: AgentsMdWriteResult): void {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return;
  const tracked = git(cwd, ['ls-files', '--', AGENTS_FILENAME]);
  if (tracked) {
    if (git(cwd, ['update-index', '--skip-worktree', '--', AGENTS_FILENAME]) !== null) result.skipWorktree = true;
    return;
  }
  const rel = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  if (!rel) return;
  result.excludeFile = isAbsolute(rel) ? rel : resolve(cwd, rel);
  result.excludeLine = `/${AGENTS_FILENAME}`;
}

async function applyExclude(result: AgentsMdWriteResult): Promise<void> {
  if (!result.excludeFile || !result.excludeLine) return;
  try {
    await mkdir(dirname(result.excludeFile), { recursive: true });
    await appendFile(result.excludeFile, `\n${result.excludeLine}\n`);
  } catch {
    result.excludeFile = undefined;
  }
}

async function removeExclude(result: AgentsMdWriteResult): Promise<void> {
  if (!result.excludeFile || !result.excludeLine) return;
  try {
    const cur = await readFile(result.excludeFile, 'utf-8');
    const next = cur.split('\n').filter((l) => l !== result.excludeLine).join('\n').replace(/\n{3,}/g, '\n\n');
    await writeFile(result.excludeFile, next);
  } catch {
    // best-effort
  }
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
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the instruction `body` into the repo's AGENTS.md as a delimited buildd
 * section. If an AGENTS.md already exists, the buildd section is appended (and
 * any stale buildd section from a prior run is replaced) without clobbering the
 * repo's own content. Returns enough state for `restoreCodexAgentsMd` to undo it
 * so we never leave the repo dirty.
 */
export async function writeCodexAgentsMd(cwd: string, body: string): Promise<AgentsMdWriteResult> {
  const path = join(cwd, AGENTS_FILENAME);
  let symlinkTarget: string | undefined;
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) symlinkTarget = await readlink(path);
  } catch {
    // does not exist
  }
  const existed = await pathExists(path);
  let originalContent: string | undefined;

  const section = `${BUILDD_AGENTS_BEGIN}\n${body}\n${BUILDD_AGENTS_END}\n`;
  const result: AgentsMdWriteResult = { path, existed, symlinkTarget };

  // Decide protection before touching the file, so a crash mid-write cannot
  // leave a tracked change that a commit would pick up.
  hideFromGit(cwd, result);
  await applyExclude(result);

  if (existed) {
    originalContent = await readFile(path, 'utf-8');
    result.originalContent = originalContent;
    // Never write through a symlink: its target (CLAUDE.md) is a tracked file.
    if (symlinkTarget !== undefined) await rm(path, { force: true });
    // Replace any prior buildd section (avoid stacking duplicates across restarts),
    // then append the fresh one to whatever the repo owns.
    const base = stripBuilddSection(originalContent).replace(/\s+$/, '');
    const next = base.length > 0 ? `${base}\n\n${section}` : section;
    await writeFile(path, next);
  } else {
    await writeFile(path, section);
  }

  return result;
}

/**
 * Undo `writeCodexAgentsMd`: if buildd created the file, delete it; if it
 * pre-existed, restore the original content verbatim. Safe to call even if the
 * file was removed in the meantime (e.g. worktree torn down).
 */
export async function restoreCodexAgentsMd(cwd: string, result: AgentsMdWriteResult): Promise<void> {
  const { path, existed, originalContent, symlinkTarget } = result;
  try {
    if (symlinkTarget !== undefined) {
      await rm(path, { force: true });
      await symlink(symlinkTarget, path);
    } else if (!existed) {
      await rm(path, { force: true });
    } else if (originalContent !== undefined) {
      await writeFile(path, originalContent);
    }
  } catch (err) {
    // Best-effort cleanup — never let restore failures break the run's finally.
    console.error(`[codex-instructions] Failed to restore ${path}:`, err);
  }
  if (result.skipWorktree) git(cwd, ['update-index', '--no-skip-worktree', '--', AGENTS_FILENAME]);
  await removeExclude(result);
}
