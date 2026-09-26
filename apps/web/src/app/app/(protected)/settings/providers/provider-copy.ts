import { CHAT_PROVIDER_INFO, type ChatKeySummary, type KeyPolicy } from '@/lib/provider-keys-client';

export const PROVIDERS_HREF = '/app/settings/providers';

/** One line on what a key is for, stated once at the top of the page. */
export const KEY_UNLOCKS =
  'A provider key runs chat, faster goal grading, visual QA judgment and task classification. ' +
  'Runners never use it: they work on their own Claude or Codex subscription or seat.';

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
 * The chat status line: the real availability reason and the one action that
 * fixes it. It used to say "chat off · Turn on chat" when the cause was a
 * missing key.
 */
export function chatStatusCopy(
  availability: { available: boolean; reason: 'capability_disabled' | 'no_key' | null },
  key: ChatKeySummary,
  isAdmin: boolean,
  policy: KeyPolicy,
): ChatStatus {
  if (availability.available) {
    const whose = key.kind === 'own' ? 'your own key' : 'the team key';
    const text = key.kind === 'own' || key.kind === 'team'
      ? `Chat is on. It runs on ${label(key.provider)} with ${whose}.`
      : 'Chat is on.';
    return { tone: 'success', text, action: null };
  }
  if (availability.reason === 'capability_disabled') {
    return {
      tone: 'muted',
      text: 'An admin switched chat off for the team.',
      action: isAdmin ? { href: '/app/settings/ai', label: 'Turn chat back on' } : null,
    };
  }
  if (policy === 'own') {
    return {
      tone: 'warning',
      text: 'Everyone on this team brings their own key. Add yours to use chat.',
      action: { href: '/app/settings/account', label: 'Add your key' },
    };
  }
  return {
    tone: 'warning',
    text: isAdmin ? 'Chat starts once you connect a provider below.' : 'Chat starts once an admin connects a provider.',
    action: null,
  };
}
