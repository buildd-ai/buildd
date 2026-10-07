import { CHAT_PROVIDER_INFO, type ChatKeysInUse, type KeyPolicy } from '@/lib/provider-keys-client';

export const PROVIDERS_HREF = '/app/settings/providers';
const MODELS_HREF = '/app/settings/models';

const labels = CHAT_PROVIDER_INFO.map((p) => p.label);

/** The page description: any provider, any mix. None is required. */
export const PROVIDERS_DESCRIPTION =
  `Keys for ${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}. Add any mix: each model uses its own provider's key first.`;

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

type Keys = Extract<ChatKeysInUse, { kind: 'keys' }>['keys'];

/** "Anthropic, OpenAI · team keys", or "Anthropic · your key; OpenAI · team key". */
function keysLine(keys: Keys): string {
  return (['own', 'team'] as const)
    .map((whose) => keys.filter((k) => k.whose === whose))
    .filter((g) => g.length > 0)
    .map((g) => `${g.map((k) => label(k.provider)).join(', ')} · ${g[0].whose === 'own' ? 'your' : 'team'} key${g.length > 1 ? 's' : ''}`)
    .join('; ');
}

const orList = (keys: Keys) => {
  const names = keys.map((k) => label(k.provider));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
};

/**
 * The chat status line: which keys it can use, or (with none that serve the
 * default model) the one action that fixes it. Chat is always on, so this is
 * a status, never an on/off state. No provider is assumed: a team with only
 * an OpenAI key is told its keys miss the default model, not that it has none.
 */
export function chatStatusCopy(
  availability: { available: boolean; reason: 'no_key' | null },
  keys: ChatKeysInUse,
  isAdmin: boolean,
  policy: KeyPolicy,
): ChatStatus {
  if (availability.available) {
    const text = keys.kind === 'keys' ? `Chat uses: ${keysLine(keys.keys)}` : 'Chat is set up';
    return { tone: 'success', text, action: null };
  }
  if (keys.kind === 'keys') {
    const text = `Chat's default model is not one ${orList(keys.keys)} serves.`;
    if (policy === 'own') return { tone: 'warning', text, action: { href: '/app/settings/account', label: 'Add your key' } };
    return isAdmin
      ? { tone: 'warning', text, action: { href: MODELS_HREF, label: 'Choose models' } }
      : { tone: 'warning', text: `${text} Ask an admin.`, action: null };
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
