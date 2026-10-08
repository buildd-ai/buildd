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

import { isBuilddActionTool } from '@buildd/shared';

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
  // The buildd MCP multiplexes actions through its tools: `create_pr` is
  // `buildd_work` on the group surface, `buildd` on the legacy one.
  if (isBuilddActionTool(toolName)) {
    const action = (input as { action?: unknown } | null | undefined)?.action;
    return action === 'create_pr';
  }
  return false;
}

/**
 * A `pr_required` session ending with no runner-confirmed PR is a candidate
 * for session-end-classification.ts (workers.ts's post-loop branch): before
 * either failing locally or letting the server's own output-requirement gate
 * see it, classify why and try a label-specific push. Deliberately does not
 * look at commit count — the mission's own motivating case (dozens of
 * commits, no PR, a session that just stopped mid-wait) has real commits, so
 * gating classification on zero commits would skip exactly that case. What
 * commit count still decides, inside the branch itself, is the eventual
 * truthful failure message when nothing resolves it.
 */
export function prRequiredUnmet(args: { outputRequirement?: string; prCreated?: boolean }): boolean {
  return (args.outputRequirement || 'auto') === 'pr_required' && args.prCreated !== true;
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
