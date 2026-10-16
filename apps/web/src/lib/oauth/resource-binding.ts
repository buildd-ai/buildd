import { classifyResource } from './account-consent';
import { getAccountResourceUrl } from './config';
import type { TokenBinding } from './storage';

/**
 * RFC 8707 at the token endpoint: a `resource` the client sends must name the
 * audience the code or refresh token is bound to. A grant binding is the
 * account resource; a workspace binding is that workspace's older address.
 * No resource is fine (the binding decides). A workspace-bound refresh is
 * not checked: connections made before the account resource existed may send
 * `<issuer>/api/mcp` with a workspace token, and must keep refreshing until
 * the older addresses are retired.
 */
export function resourceMatchesBinding(
  resource: string | null,
  binding: TokenBinding,
  grant: 'authorization_code' | 'refresh_token',
): boolean {
  const target = classifyResource(resource, getAccountResourceUrl());
  if (target.kind === 'none') return true;
  if (typeof binding.grantId === 'string') return target.kind === 'account';
  if (grant === 'refresh_token') return true;
  return target.kind === 'legacy' && target.workspaceId === binding.workspaceId;
}
