/**
 * Who a kernel command is for (lib/workflow/command-api.ts `KernelPrincipal`), as a door names
 * it. Pure (lib/grant-scope.ts imports nothing), so it loads no database code.
 */
import { isGrantSession, type GrantScopedAccount } from '@/lib/grant-scope';
import type { KernelPrincipal } from './command-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The principal an actor string names, when it names one by itself: `human:<user id>` is that
 * person; buildd's own actors (`system:`, `rule:`, `buildd:`, or none) are the system. An agent
 * run, or a person without a valid id, names no principal: its door must pass the caller's
 * (`kernelPrincipalOf`), and a command without one is never sent to the control plane.
 */
export function principalOfActor(actor: string | null | undefined): KernelPrincipal | null {
  const a = actor ?? 'system:door';
  const human = /^human:(.+)$/.exec(a);
  if (human) return UUID.test(human[1]) ? { kind: 'user', id: human[1] } : null;
  if (/^(system|rule|buildd):/.test(a)) return { kind: 'system', id: a.slice(0, 200) };
  return null;
}

/** The authenticated API caller as the door saw it: the session object, never a bare id. */
export interface KernelCaller {
  /** The person behind the request (a dashboard session or a person's own OAuth session). */
  person?: string | null;
  account?: (GrantScopedAccount & { id: string }) | null;
}

/**
 * The principal a door submits for its caller, carrying what the web host's own check
 * (`verifyAccountWorkspaceAccess` on the session) read: a grant session as a grant, with the
 * workspaces it reaches on this request, whether or not a person is behind it; else the person;
 * else the API account, marked as not a grant. Null when there is no caller.
 */
export function kernelPrincipalOf(caller: KernelCaller): KernelPrincipal | null {
  const { account, person } = caller;
  if (account && isGrantSession(account)) {
    return {
      kind: 'grant', id: account.id, grantId: String(account.oauthGrantId),
      workspaceIds: Array.isArray(account.workspaceIds) ? [...account.workspaceIds] : [],
      scopes: Array.isArray(account.grantScopes) ? [...account.grantScopes] : [],
      ...(person ? { userId: person } : {}),
    };
  }
  if (person) return { kind: 'user', id: person };
  if (account) return { kind: 'account', id: account.id, grant: null };
  return null;
}
