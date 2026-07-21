/**
 * PR-creation detection for the `pr_required` / `artifact_required` output gate.
 *
 * The gate must distinguish a create_pr call that *ran* from one that actually
 * *produced a PR*. GitHub can reject the call (e.g. 422 "head invalid" when the
 * branch was never pushed) — the tool still executed and shows up in the tool
 * call log, but no PR exists. Trusting the mere presence of a create_pr tool
 * call lets a failed attempt satisfy the gate, so the worker sails past the
 * nudge/review loop and calls complete_task, which the server then rejects with
 * a misleading "requires a pull request" 400. Detect a *real* PR instead, from
 * the create_pr result the server echoes back.
 */

/** GitHub PR URL as echoed by a successful create_pr (`**URL:** …/pull/123`). */
const PR_URL_RE = /https?:\/\/github\.com\/[^\s"'`)]+\/pull\/\d+/i;

/** Server success sentinel from mcp-tools.ts create_pr handler. */
const PR_SUCCESS_RE = /pull request created/i;

/** Extract the first GitHub PR URL from arbitrary text, or null. */
export function extractPrUrl(text: string): string | null {
  const m = text.match(PR_URL_RE);
  return m ? m[0] : null;
}

/** Is this tool call a create_pr (direct tool or buildd MCP action)? */
export function isCreatePrCall(toolName: string | undefined, input: unknown): boolean {
  if (!toolName) return false;
  if (toolName === 'create_pr') return true;
  // The buildd MCP multiplexes many actions through a single `buildd` tool.
  if (toolName === 'mcp__buildd__buildd') {
    const action = (input as { action?: unknown } | null | undefined)?.action;
    return action === 'create_pr';
  }
  return false;
}

/**
 * A pr_required session should fail with the agent's own diagnosis (rather than
 * attempting completion and eating the server's generic 400) only when there is
 * demonstrably nothing to open a PR from: no confirmed PR AND no commits. When
 * commits exist, completion is allowed to reach the server, which can still
 * auto-detect a PR opened out-of-band via `gh pr create`.
 */
export function shouldFailForMissingPr(args: {
  outputRequirement?: string;
  prCreated?: boolean;
  commitCount: number;
}): boolean {
  return (
    (args.outputRequirement || 'auto') === 'pr_required' &&
    args.prCreated !== true &&
    args.commitCount === 0
  );
}

/**
 * Given a create_pr tool result, decide whether a PR was actually created.
 * Returns `created: false` for non-create_pr calls, errored results, and
 * results that carry no success sentinel or PR URL (the failed-422 case).
 */
export function detectCreatedPr(args: {
  toolName?: string;
  input?: unknown;
  resultText: string;
  isError?: boolean;
}): { created: boolean; url: string | null } {
  if (!isCreatePrCall(args.toolName, args.input)) return { created: false, url: null };
  if (args.isError === true) return { created: false, url: null };
  const url = extractPrUrl(args.resultText);
  const created = !!url || PR_SUCCESS_RE.test(args.resultText);
  return { created, url };
}
