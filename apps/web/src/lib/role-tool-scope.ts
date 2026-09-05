/**
 * What a role's `allowedTools` list actually governs, in words.
 *
 * The field reads like a tool-access policy for the role's agent. It is not
 * one. Its only runtime consumer is the skill-bundle → subagent conversion in
 * `apps/runner/src/workers.ts`, which turns the list into that subagent's
 * `tools` and substitutes `SUBAGENT_DEFAULT_TOOLS` when it is empty. The
 * primary agent's allowlist is built from skill scoping (`Skill(<slug>)`)
 * alone, so this list never narrows it — and `roleConfig.allowedTools`, which
 * the claim response ships to the runner, is read by nothing at all.
 *
 * Widening enforcement is a separate, gated change. Until it lands, this copy
 * is the only thing stopping the control from claiming authority it does not
 * have, so it lives here with tests rather than as strings in three JSX trees.
 */

/**
 * The set the runner substitutes for an empty list, so "empty" can be stated as
 * what it is instead of as "all tools". Mirrors the `defaultTools` literal in
 * `apps/runner/src/workers.ts`.
 */
export const SUBAGENT_DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'] as const;

/** Heading for the tool-chip control, in place of the unqualified "Allowed Tools". */
export const SUBAGENT_TOOLS_LABEL = 'Subagent Tools';

/** The scope of the control, stated where it is configured. */
export const SUBAGENT_TOOLS_NOTE =
  `Applies when this role runs as a skill subagent — it does not narrow the main agent on a task. ` +
  `Empty = the subagent default set (${SUBAGENT_DEFAULT_TOOLS.join(', ')}).`;

/**
 * The current selection, summarised.
 *
 * Deliberately not "N restricted" / "All allowed": both describe a restriction
 * on the agent, which is the assertion this field cannot back.
 */
export function subagentToolsSummary(
  allowedTools: readonly string[] | null | undefined,
): string {
  const count = allowedTools?.length ?? 0;
  if (count === 0) return 'Subagent defaults';
  return `${count} subagent tool${count === 1 ? '' : 's'}`;
}
