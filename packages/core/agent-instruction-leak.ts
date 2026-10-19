/**
 * Guard against a runner's injected agent-instruction block reaching a commit.
 *
 * The Codex path writes a delimited role/skills block into the checkout so the
 * model reads it (apps/runner/src/codex-instructions.ts). It is for the agent,
 * never for the repo. One run committed it into CLAUDE.md, so create_pr refuses
 * a diff that adds the marker.
 */

/** Marker text shared with the runner's BUILDD_AGENTS_BEGIN (a test pins them equal). */
export const AGENT_INSTRUCTIONS_MARKER = 'BEGIN buildd agent instructions';

export interface DiffFileLike {
  filename: string;
  patch?: string | null;
}

/** Files whose added lines contain the marker. Removed and context lines are ignored. */
export function findInstructionLeaks(files: DiffFileLike[]): string[] {
  const leaked: string[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    const added = f.patch.split('\n').some((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(AGENT_INSTRUCTIONS_MARKER));
    if (added) leaked.push(f.filename);
  }
  return leaked;
}
