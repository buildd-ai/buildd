/**
 * PR-mutation deny — defence in depth, NOT the gate.
 *
 * The correctness guarantee for which branch a PR targets lives server-side
 * (the platform derives head/base at PR-creation time). This file only
 * narrows what a worker can *reach* from inside its own session, so the
 * common accidental path — a worker fat-fingering `gh pr create` or a
 * mounted connector's `update_pull_request` instead of the buildd
 * `create_pr`/`merge_pr`/`close_pr` actions — is closed for roles that have
 * no legitimate reason to mutate a PR outside those actions.
 *
 * What this deliberately does NOT cover:
 *   - `gh api`, which reaches the same REST endpoints under a different verb.
 *     A subcommand-level deny can't tell a read `gh api` call from a write
 *     one without reimplementing GitHub's REST surface here, so it is left
 *     alone — the same reasoning that leaves `gh pr view/list/checks` alone.
 *   - plain HTTP to api.github.com with any token the sandbox holds — not
 *     blockable without removing the credential.
 * Both surfaces mean this can never be promoted to "the" enforcement point;
 * it only removes the easy accidental path.
 */

/** `gh pr <subcommand>` verbs that mutate a PR. Read-only usage (view, list, checks) is untouched. */
export const PR_MUTATION_BASH_DENY: readonly string[] = [
  'Bash(gh pr create:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr reopen:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh pr review:*)',
];

/**
 * Known PR-write tool names on the GitHub MCP server surface a workspace
 * might mount as a connector — the same tool the `merge_pr`/`close_pr`
 * action docs already steer callers away from (`update_pull_request`).
 *
 * Blocked on ANY mounted MCP server by exact tool name, not by connector
 * name: a connector's name is admin-chosen and not knowable ahead of time
 * (no GitHub connector is mounted for this workspace today), so matching by
 * name would miss it. Naming a tool nothing mounts is inert — see
 * applyCbmToolBlocklist in cbm-enforcement.ts for the same idiom — so
 * blocking these unconditionally for a denied role costs nothing today and
 * closes the gap the moment such a connector is added to that role.
 *
 * Not a guarantee: this is the tool surface as commonly documented for the
 * github/github-mcp-server project, not something verifiable against a live
 * connector from inside this codebase. A server exposing PR mutation under a
 * different tool name reaches the agent unblocked — the same limitation
 * CBM's own blocklist carries for tools added after it was classified.
 */
export const GITHUB_MCP_PR_WRITE_TOOLS: readonly string[] = [
  'create_pull_request',
  'update_pull_request',
  'merge_pull_request',
  'update_pull_request_branch',
  'create_pending_pull_request_review',
  'submit_pending_pull_request_review',
  'delete_pending_pull_request_review',
  'create_and_submit_pull_request_review',
  'add_comment_to_pending_review',
  'request_copilot_review',
];

/**
 * Roles this deny applies to. Builder is the only default role that both
 * carries a bare `Bash` grant and routinely ships PRs. Organizer also
 * carries Bash but never mutates PRs in its own workflow (mission planning +
 * workspace/repo scaffolding) and was explicitly left untouched — narrowing
 * a role that does not exercise the risky path anyway is not free, since it
 * is one more thing to get wrong for zero behavioural change, and the task
 * that requested this deny named Organizer as out of scope. Reviewer has no
 * Bash at all. Widen this set only after confirming a new role needs the
 * same narrowing, not by assuming Builder is the only one that could.
 */
const PR_MUTATION_DENY_ROLES = new Set(['builder']);

/**
 * Whether this session should have PR mutation denied.
 *
 * Gated on `hasApiKey`: when the buildd MCP has no API key configured,
 * prompt-builder's git-workflow section falls back to instructing the agent
 * to run `gh pr create` directly — that fallback is its only path to a PR at
 * all in that configuration, so denying it there would remove the one
 * working path instead of the accidental one. See prompt-builder.ts's
 * `hasApiKey` branch, which this mirrors so the two never disagree.
 */
export function shouldDenyPrMutation(roleSlug: string | undefined, hasApiKey: boolean): boolean {
  return !!roleSlug && PR_MUTATION_DENY_ROLES.has(roleSlug) && hasApiKey;
}

/**
 * Append the PR-mutation deny (shell subcommands + connector tool names) to
 * a session's disallowedTools. Applied unconditionally when the gate passes
 * — see the module doc on why naming an unmounted/inapplicable rule is safe.
 */
export function applyPrMutationDeny(
  existing: readonly string[] | undefined,
  ctx: { roleSlug: string | undefined; hasApiKey: boolean; mountedServerNames: readonly string[] },
): string[] {
  const base = [...(existing ?? [])];
  if (!shouldDenyPrMutation(ctx.roleSlug, ctx.hasApiKey)) return base;

  const connectorDeny = ctx.mountedServerNames
    .filter(name => name !== 'buildd')
    .flatMap(server => GITHUB_MCP_PR_WRITE_TOOLS.map(tool => `mcp__${server}__${tool}`));

  return [...new Set([...base, ...PR_MUTATION_BASH_DENY, ...connectorDeny])];
}
