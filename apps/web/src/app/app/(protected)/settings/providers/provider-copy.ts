import { CHAT_PROVIDER_INFO, type ChatKeySummary, type KeyPolicy } from '@/lib/provider-keys-client';

export const PROVIDERS_HREF = '/app/settings/providers';

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
 * The chat status line: what it uses, or (with no key) the one action that
 * fixes it. Chat is always on, so this is a status, never an on/off state.
 */
export function chatStatusCopy(
  availability: { available: boolean; reason: 'no_key' | null },
  key: ChatKeySummary,
  isAdmin: boolean,
  policy: KeyPolicy,
): ChatStatus {
  if (availability.available) {
    const whose = key.kind === 'own' ? 'your key' : 'team key';
    const text = key.kind === 'own' || key.kind === 'team'
      ? `Chat uses: ${label(key.provider)} · ${whose}`
      : 'Chat is set up';
    return { tone: 'success', text, action: null };
  }
  if (policy === 'own') {
    return {
      tone: 'warning',
      text: 'Chat needs your own key.',
      action: { href: '/app/settings/account', label: 'Add your key' },
    };
  }
  return {
    tone: 'warning',
    text: isAdmin ? 'Chat needs a key. Add one below.' : 'Chat needs a key. Ask an admin.',
    action: null,
  };
}
