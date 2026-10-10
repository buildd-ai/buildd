/**
 * Pure half of credential-block (no db): safe to import from client components.
 */

export const CREDENTIAL_BLOCK_CONTEXT_KEY = 'credentialBlock';

export type CredentialRoute = 'claude' | 'codex' | 'cloud';
export interface CredentialBlock {
  route: CredentialRoute;
  /** `personal` when the team policy only accepts the requester's own key. */
  scope: 'team' | 'personal';
}

const ROUTES: readonly CredentialRoute[] = ['claude', 'codex', 'cloud'];
const SURFACE_ROUTE: Record<string, CredentialRoute> = {
  'agent-claude': 'claude',
  'agent-codex': 'codex',
  'cloud-egress': 'cloud',
};

/** The block a claim deferral implies, or null when it is not about a missing key. */
export function credentialBlockFromDeferral(reason: string, detail: Record<string, unknown> = {}): CredentialBlock | null {
  if (reason === 'no_personal_credential') {
    const route = typeof detail.surface === 'string' ? SURFACE_ROUTE[detail.surface] : undefined;
    return route ? { route, scope: 'personal' } : null;
  }
  if (reason === 'provider_unavailable' && detail.attemptedBackend === 'codex') return { route: 'codex', scope: 'team' };
  return null;
}

export function parseCredentialBlock(raw: unknown): CredentialBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!ROUTES.includes(v.route as CredentialRoute)) return null;
  return { route: v.route as CredentialRoute, scope: v.scope === 'personal' ? 'personal' : 'team' };
}

const NOUN: Record<CredentialRoute, string> = { claude: 'Claude', codex: 'Codex', cloud: 'cloud route' };

export function credentialBlockCopy(block: CredentialBlock): { line: string; cta: string; href: string } {
  return {
    line: `Needs a ${NOUN[block.route]} key`,
    cta: `Add a ${NOUN[block.route]} key`,
    href: block.scope === 'personal' ? '/app/settings/models?scope=mine#keys' : '/app/settings/models#keys',
  };
}

