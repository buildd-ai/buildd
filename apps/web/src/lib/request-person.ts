/**
 * The person behind a request, for a person-only action (a `human:` actor in
 * the workflow kernel, docs/specs/workflow-state-kernel.md T5/T21; a landing
 * override; a landing-override grant).
 *
 * A person is a dashboard (cookie) session, or the person's own interactive
 * OAuth session (MCP or chat), which carries the signed-in user as
 * `sessionUserId`. An API key or a per-task token is never a person, whatever
 * its level. When a bearer authenticated the request, it decides: a key that
 * rides along with a browser cookie still acts as the key.
 *
 * An OAuth session on an account-level MCP grant is a person only when the
 * grant acts as 'person'; an 'agent' grant is attributed to the user but is
 * never a person (lib/mcp-grants.ts).
 *
 * Runner-launched agents always authenticate with a per-task token or the
 * runner's key, never an OAuth session, so they always act as `agent:`.
 */
export function requestingPerson(
  user: { id?: string | null } | null | undefined,
  account: object | null | undefined,
): string | null {
  if (account) {
    const a = account as { sessionUserId?: unknown; taskScope?: unknown; actsAs?: unknown };
    if (a.taskScope) return null;
    // An OAuth session on an 'agent' grant acts as the user's agent, never as
    // the person (lib/mcp-grants.ts). It carries no sessionUserId either; this
    // keeps the refusal if one is ever attached.
    if (a.actsAs === 'agent') return null;
    return typeof a.sessionUserId === 'string' && a.sessionUserId ? a.sessionUserId : null;
  }
  return typeof user?.id === 'string' && user.id ? user.id : null;
}
