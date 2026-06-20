import { readFile, writeFile, rm, access } from 'fs/promises';
import { join } from 'path';

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
 * Why AGENTS.md over a prompt preamble: the worker run is multi-turn (PR2 turn
 * loop — review prompts, output-requirement nudges, steering follow-ups all run
 * additional turns on the same thread). A prompt preamble would only be attached
 * to the *first* turn's input string; AGENTS.md is re-read by Codex on every
 * turn, so the persona + skills + DONE convention persist for the whole session.
 * (We still prepend a one-line pointer to the prompt itself — see workers.ts.)
 *
 * The DONE-sentinel instruction is load-bearing: PR2 wired Codex's
 * `agent_message` text into `worker.lastAssistantMessage`, and the review-loop
 * exit gate (`workers.ts` ~1576) only releases when that text contains
 * `<promise>DONE</promise>`. Codex is never *told* to emit it unless we say so
 * here, so without 2A every Codex task burns all review iterations and exits
 * "exhausted". This file is what unblocks PR2's R1 gate.
 */

export const DONE_SENTINEL = '<promise>DONE</promise>';

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
 * Compose the Codex instruction document: role persona + inlined skill content +
 * optional project instructions + the DONE-sentinel completion convention.
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

  // Always present — this is the review-loop exit contract.
  sections.push(
    `# Completion\n\nWhen the task is fully complete and your own self-review passes, respond with exactly this sentinel on its own line:\n\n${DONE_SENTINEL}\n\nOnly emit ${DONE_SENTINEL} once everything the task asked for is done with no shortcuts, stubs, or TODOs left behind. If work remains, keep going instead of emitting it.`,
  );

  return sections.join('\n\n');
}

export interface AgentsMdWriteResult {
  /** Absolute path to the AGENTS.md that was written. */
  path: string;
  /** Whether an AGENTS.md already existed before we wrote (drives cleanup mode). */
  existed: boolean;
  /** The original file content when it pre-existed (restored verbatim on cleanup). */
  originalContent?: string;
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
  const existed = await pathExists(path);
  let originalContent: string | undefined;

  const section = `${BUILDD_AGENTS_BEGIN}\n${body}\n${BUILDD_AGENTS_END}\n`;

  if (existed) {
    originalContent = await readFile(path, 'utf-8');
    // Replace any prior buildd section (avoid stacking duplicates across restarts),
    // then append the fresh one to whatever the repo owns.
    const base = stripBuilddSection(originalContent).replace(/\s+$/, '');
    const next = base.length > 0 ? `${base}\n\n${section}` : section;
    await writeFile(path, next);
  } else {
    await writeFile(path, section);
  }

  return { path, existed, originalContent };
}

/**
 * Undo `writeCodexAgentsMd`: if buildd created the file, delete it; if it
 * pre-existed, restore the original content verbatim. Safe to call even if the
 * file was removed in the meantime (e.g. worktree torn down).
 */
export async function restoreCodexAgentsMd(_cwd: string, result: AgentsMdWriteResult): Promise<void> {
  const { path, existed, originalContent } = result;
  try {
    if (!existed) {
      await rm(path, { force: true });
      return;
    }
    if (originalContent !== undefined) {
      await writeFile(path, originalContent);
    }
  } catch (err) {
    // Best-effort cleanup — never let restore failures break the run's finally.
    console.error(`[codex-instructions] Failed to restore ${path}:`, err);
  }
}
