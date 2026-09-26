/**
 * "Connect OpenRouter": a plain link into the OAuth PKCE flow
 * (/api/inference-keys/openrouter/start). OpenRouter creates the key in the
 * person's own account, so there is nothing to copy or paste.
 */
export function openRouterConnectHref(o: { scope: 'team' | 'user'; teamId: string; returnTo: string }): string {
  const qs = new URLSearchParams({ scope: o.scope, teamId: o.teamId, returnTo: o.returnTo });
  return `/api/inference-keys/openrouter/start?${qs}`;
}

export default function ConnectOpenRouterButton({ scope, teamId, returnTo, label = 'Connect OpenRouter' }: {
  scope: 'team' | 'user';
  teamId: string;
  returnTo: string;
  label?: string;
}) {
  return (
    <a
      href={openRouterConnectHref({ scope, teamId, returnTo })}
      data-testid="connect-openrouter"
      className="btn btn-primary"
    >
      {label}
    </a>
  );
}

/** What a finished or failed Connect OpenRouter redirect means, in one line. */
export function providerFlowMessage(params: { get(name: string): string | null }): { tone: 'ok' | 'err'; text: string } | null {
  if (params.get('connected') === 'openrouter') return { tone: 'ok', text: 'OpenRouter is connected.' };
  const err = params.get('provider_error');
  if (!err) return null;
  const text: Record<string, string> = {
    cancelled: 'You closed OpenRouter before it made a key. Try again when you are ready.',
    expired: 'That sign-in timed out. Start it again.',
    exchange: 'OpenRouter did not hand over a key. Try again, or paste one instead.',
    rejected: 'OpenRouter made a key but would not accept it back. Try again, or paste one instead.',
    not_admin: 'Only a team owner or admin can connect the team key.',
    team_key_only: 'Your team pays for chat with the team key, so there is nothing for you to connect.',
    team: 'That team is not one of yours.',
  };
  return { tone: 'err', text: text[err] ?? 'Connecting OpenRouter failed. Try again.' };
}
