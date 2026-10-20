/**
 * A question to a person that is really a request for provider access.
 *
 * Provider MCP access (Axiom, Sentry, PostHog, ...) is requested with
 * `request_capability { provider, access, resource? }`, resolved by team
 * policy and approved by a person on the task's own grant. It is never a
 * matter of widening the worker's buildd key: `analytics:read` is buildd's own
 * analytics (decision ledger, stats, health), unrelated to any provider.
 * `ask_human` refuses such a question and hands back the canonical ask.
 * docs/specs/capability-requests.md.
 */
export const PROVIDER_SLUGS = ['axiom', 'sentry', 'posthog', 'vercel', 'neon', 'supabase', 'linear', 'notion'] as const;

const ACCESS_WORDS = /\b(access|permissions?|scopes?|widen\w*|grant\w*|authori[sz]\w*|credentials?|api[ -]?keys?|worker[ -]?key|tokens?|analytics:read|connect\w*|read[ -]only|read)\b/i;
const WRITE_WORDS = /\b(write|mutate|create|delete|deploy|admin)\b/i;
const RESOURCE_RE = /\b([a-z0-9]+(?:-[a-z0-9]+)*-(?:traces|logs|events|metrics))\b/i;

export interface ProviderAccessAsk {
  provider: (typeof PROVIDER_SLUGS)[number];
  access: 'read' | 'write';
  resource?: string;
}

/** Pure. The provider ask a question amounts to, or null for an ordinary question. */
export function detectProviderAccessAsk(...texts: Array<string | undefined>): ProviderAccessAsk | null {
  const text = texts.filter(Boolean).join('\n');
  const provider = PROVIDER_SLUGS.find(slug => new RegExp(`\\b${slug}\\b`, 'i').test(text));
  if (!provider || !ACCESS_WORDS.test(text)) return null;
  const resource = text.match(RESOURCE_RE)?.[1]?.toLowerCase();
  return { provider, access: WRITE_WORDS.test(text) ? 'write' : 'read', ...(resource ? { resource } : {}) };
}

/** The structured refusal `ask_human` returns instead of parking. */
export function providerAccessRefusal(ask: ProviderAccessAsk) {
  const body = { provider: ask.provider, access: ask.access, ...(ask.resource ? { resource: ask.resource } : {}) };
  return {
    error: 'use_request_capability',
    reason: `This asks a person for ${ask.provider} access. Ask for it with request_capability, not a question: team policy answers or a person approves, and your run continues. Do not ask anyone to widen the worker key: analytics:read is buildd's own analytics, not ${ask.provider}.`,
    request: { action: 'request_capability', params: body },
    nextSteps: [
      `Call request_capability ${JSON.stringify(body)}.`,
      'pending_approval: keep working and ask again (same request); never ask_human for the same access.',
      'need_connection / need_reauth / unhealthy: the answer says who must (re)connect the provider; report that outcome, not a key change.',
    ],
  };
}
