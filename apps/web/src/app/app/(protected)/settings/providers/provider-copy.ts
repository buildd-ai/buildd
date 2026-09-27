import { CHAT_PROVIDER_INFO, type ChatKeySummary, type KeyPolicy } from '@/lib/provider-keys-client';

export const PROVIDERS_HREF = '/app/settings/providers';

/** One line on what a key is for, stated once at the top of the page. */
export const KEY_UNLOCKS = 'Pays for interactive AI and server-side features. Runners use their own seat.';

export interface PolicyChoice {
  mode: 'team' | 'own';
  /** Only meaningful with mode 'team'. */
  allowOwn: boolean;
}

export function policyFromChoice(c: PolicyChoice): KeyPolicy {
  if (c.mode === 'own') return 'own';
  return c.allowOwn ? 'team_or_own' : 'team';
}

export function choiceFromPolicy(p: KeyPolicy): PolicyChoice {
  if (p === 'own') return { mode: 'own', allowOwn: false };
  return { mode: 'team', allowOwn: p === 'team_or_own' };
}

const label = (id: string) => CHAT_PROVIDER_INFO.find((p) => p.id === id)?.label ?? id;

export interface ChatStatus {
  tone: 'success' | 'warning' | 'muted';
  text: string;
  action: { href: string; label: string } | null;
}

/**
 * The interactive AI status line: the real availability reason and the one
 * action that fixes it. It used to say "chat off · Turn on chat" when the
 * cause was a missing key.
 */
export function chatStatusCopy(
  availability: { available: boolean; reason: 'capability_disabled' | 'no_key' | null },
  key: ChatKeySummary,
  isAdmin: boolean,
  policy: KeyPolicy,
): ChatStatus {
  if (availability.available) {
    const whose = key.kind === 'own' ? 'your key' : 'team key';
    const text = key.kind === 'own' || key.kind === 'team'
      ? `Interactive AI is on · ${label(key.provider)} · ${whose}`
      : 'Interactive AI is on';
    return { tone: 'success', text, action: null };
  }
  if (availability.reason === 'capability_disabled') {
    return {
      tone: 'muted',
      text: 'Interactive AI is off for the team',
      action: isAdmin ? { href: '/app/settings/ai', label: 'Turn it on' } : null,
    };
  }
  if (policy === 'own') {
    return {
      tone: 'warning',
      text: 'Each person uses their own key. Add yours.',
      action: { href: '/app/settings/account', label: 'Add your key' },
    };
  }
  return {
    tone: 'warning',
    text: isAdmin ? 'Connect a provider below to start interactive AI' : 'Interactive AI starts once an admin connects a provider',
    action: null,
  };
}
