'use client';

/**
 * Settings → Agent backends: tells a team that still stores a subscription
 * login in buildd (a Claude setup token or sign-in, a ChatGPT login for Codex)
 * that buildd will stop storing them, and how to move the login onto the
 * runner machine instead. Metered keys (Anthropic or OpenAI API key, an agent
 * endpoint) are not affected and never trigger it.
 */

export const RUNNER_LOGIN_DOCS_URL =
  'https://github.com/buildd-ai/buildd/blob/dev/apps/runner/README.md#model-login-on-the-runner-machine';

export type StoredSeatKind = 'claude' | 'codex';

const SEAT_PURPOSES: Record<string, StoredSeatKind> = {
  oauth_token: 'claude',
  claude_credential: 'claude',
  codex_credential: 'codex',
};

/** Which subscription logins this team stores, from the `/api/secrets` list (metadata only). */
export function storedSeatKinds(secrets: Array<{ purpose?: string | null }> | null | undefined): StoredSeatKind[] {
  const kinds = new Set<StoredSeatKind>();
  for (const s of secrets ?? []) {
    const k = s.purpose ? SEAT_PURPOSES[s.purpose] : undefined;
    if (k) kinds.add(k);
  }
  return (['claude', 'codex'] as const).filter((k) => kinds.has(k));
}

export default function StoredSeatNotice({ kinds }: { kinds: StoredSeatKind[] }) {
  if (kinds.length === 0) return null;
  const what = kinds.length === 2
    ? 'a Claude login and a ChatGPT (Codex) login'
    : kinds[0] === 'claude' ? 'a Claude login' : 'a ChatGPT (Codex) login';
  return (
    <div className="inset-panel border border-status-warning/40 space-y-2" data-testid="stored-seat-notice" role="status">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="status-pill status-pill-warn">Moving to your runner</span>
      </div>
      <p className="text-xs text-text-secondary">
        This team stores {what} in buildd. Buildd will stop storing subscription logins, and
        stored ones will be removed. Your runners keep working until then.
      </p>
      <p className="text-xs text-text-secondary">
        To move: sign in on each runner machine ({kinds.includes('claude') ? <code>claude login</code> : null}
        {kinds.length === 2 ? ' and ' : null}
        {kinds.includes('codex') ? <code>codex login</code> : null}
        {kinds.includes('claude') ? <>, or put a <code>claude setup-token</code> value in the runner&apos;s environment</> : null}),
        set <code>BUILDD_HOST_SEAT=prefer</code>, restart the runner and check one task. API keys and
        model endpoints stay here and are not affected.
      </p>
      <a href={RUNNER_LOGIN_DOCS_URL} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
        How to set up a login on the runner
      </a>
    </div>
  );
}
