/**
 * Shared pieces of the account-level MCP transport (/api/mcp on a grant
 * token) and of the deprecated per-workspace endpoint
 * (/api/mcp-oauth/[workspace]). Route files may export only handlers, so
 * what both routes and their tests read lives here.
 */
import type { ToolResult, WorkspaceListing } from '@buildd/core/mcp-tools';
import { getIssuer } from './oauth/config';
import type { GrantWorkspaceChoice, GrantWorkspaceResolution } from './mcp-grants';

/** How many choices a workspace refusal lists before pointing at list_workspaces. */
export const GRANT_CHOICES_SHOWN = 20;

export function toListing(c: GrantWorkspaceChoice): WorkspaceListing {
  return { workspaceId: c.workspaceId, name: c.name, repo: c.repo, teamId: c.teamId, teamName: c.teamName, level: c.level, access: c.access };
}

/**
 * The structured refusal for a call whose workspace cannot be resolved among
 * the grant. Lists granted workspaces only, and never echoes the reference:
 * a workspace the grant does not cover reads exactly like one that does not
 * exist.
 */
export function grantWorkspaceRefusal(r: Exclude<GrantWorkspaceResolution, { kind: 'ok' }>): ToolResult {
  const error = r.kind === 'required' ? 'workspace_required' : r.kind === 'ambiguous' ? 'workspace_ambiguous' : 'workspace_not_granted';
  const message = r.kind === 'required'
    ? 'This connection reaches more than one workspace. Pass workspaceId (UUID, owner/repo or name) in params; nothing is picked for you.'
    : r.kind === 'ambiguous'
      ? 'That name matches more than one workspace this connection reaches. Pass the workspace id instead.'
      : 'That workspace is not one this connection reaches. Choose one of the workspaces granted to it.';
  const choices = r.choices.slice(0, GRANT_CHOICES_SHOWN).map((c) => ({
    workspaceId: c.workspaceId, name: c.name, ...(c.repo ? { repo: c.repo } : {}), team: c.teamName,
  }));
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error,
        message,
        choices,
        ...(r.choices.length > choices.length ? { more: r.choices.length - choices.length } : {}),
        hint: 'list_workspaces lists every workspace this connection can act in.',
      }),
    }],
  };
}

export type JsonRpcMessage = { method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };

/**
 * The workspace reference a tool call names, if any: params.workspaceId on the
 * buildd / buildd_<group> tools (or a flat workspaceId), workspaceId on
 * recall / learn.
 */
export function callWorkspaceRef(args: Record<string, unknown> | undefined): { ref: string | null; holder: Record<string, unknown> | null } {
  if (!args) return { ref: null, holder: null };
  const p = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params as Record<string, unknown> : null;
  if (p && typeof p.workspaceId === 'string' && p.workspaceId.trim()) return { ref: p.workspaceId, holder: p };
  if (typeof args.workspaceId === 'string' && args.workspaceId.trim()) return { ref: args.workspaceId, holder: args };
  return { ref: null, holder: null };
}

/**
 * This per-workspace endpoint is deprecated in favour of the canonical
 * account-level `<issuer>/api/mcp` (one connection, the workspaces you grant
 * it, across teams). Existing connections keep working; responses say so in
 * the instructions and in Deprecation / Link headers (RFC 9745, RFC 8288).
 */
export const LEGACY_ENDPOINT_NOTICE = 'Deprecated endpoint: this connection is bound to one workspace. Reconnect to the canonical /api/mcp endpoint instead: one connection reaches the workspaces you choose at sign-in, across teams, and its list_workspaces action shows them. This endpoint keeps working until you switch.';

export function deprecationHeaders(): Record<string, string> {
  return {
    Deprecation: 'true',
    Link: `<${getIssuer()}/api/mcp>; rel="successor-version"`,
  };
}

