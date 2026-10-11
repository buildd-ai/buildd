'use client';

import Notice from '@/components/ui/Notice';

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
    <Notice tone="warn" title="Moving to your runner" className="mx-4 my-3" data-testid="stored-seat-notice">
      <p className="text-xs text-text-secondary">
        This team stores {what} in buildd. Buildd will stop storing subscription logins, and
        stored ones will be removed. Your runners keep working until then.
      </p>
      <p className="mt-2 text-xs text-text-secondary">
        Sign in on each runner ({kinds.map((k, i) => (
          <span key={k}>{i > 0 ? ' and ' : ''}<code>{k === 'claude' ? 'claude login' : 'codex login'}</code></span>
        ))}), then set <code>BUILDD_HOST_SEAT=prefer</code>. API keys are not affected.
      </p>
      <a href={RUNNER_LOGIN_DOCS_URL} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs underline hover:text-text-primary">
        How to set up a login on the runner
      </a>
    </Notice>
  );
}
