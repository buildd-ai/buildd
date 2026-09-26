import { CHAT_PROVIDER_INFO, type ChatKeySummary, type ChatProvider, type ProviderCard } from '@/lib/provider-keys-client';

const label = (id: string) => CHAT_PROVIDER_INFO.find((p) => p.id === id)?.label ?? id;

/**
 * The single "Chat uses" row on Account. Provider setup lives in Connections →
 * Model providers; a member only needs to know what their chat runs on and who
 * to ask, so there is never a grid of "not connected" cards here.
 */
export function chatKeyLine(
  key: ChatKeySummary,
  ctx: { isAdmin: boolean; chatDisabled: boolean },
): { text: string; action: { href: string; label: string } | null } {
  if (ctx.chatDisabled) return { text: 'Off for this team', action: ctx.isAdmin ? { href: '/app/settings/ai', label: 'Turn it on' } : null };
  if (key.kind === 'team') return { text: `${label(key.provider)} · team key`, action: null };
  if (key.kind === 'own') return { text: `${label(key.provider)} · your key`, action: null };
  if (key.kind === 'needs_own') return { text: 'Add your OpenRouter key to use chat', action: null };
  return ctx.isAdmin
    ? { text: 'Not set up yet', action: { href: '/app/settings/providers', label: 'Set it up' } }
    : { text: 'Not set up yet · ask an admin', action: null };
}

/**
 * Providers to offer for "use my own key": OpenRouter, any provider the team
 * holds a key for (so chat routes through it), and any you already hold.
 */
export function ownKeyProviders(cards: readonly Pick<ProviderCard, 'provider' | 'team' | 'mine'>[]): ChatProvider[] {
  return cards
    .filter((c) => c.provider === 'openrouter' || !!c.team || !!c.mine)
    .map((c) => c.provider);
}
