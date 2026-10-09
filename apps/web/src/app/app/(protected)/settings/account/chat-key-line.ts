import { providerKeyCapability } from '@builddai/ai-kit/models/provider-keys';
import { CHAT_PROVIDER_INFO, type ChatKeySummary, type ChatProvider, type ProviderCard } from '@/lib/provider-keys-client';

const label = (id: string) => providerKeyCapability(id)?.label ?? id;

/**
 * The single "Your keys" line on Profile. Provider setup lives in Settings ›
 * Models; a member only needs to know what their chat runs on and who to ask,
 * so there is never a grid of "not connected" cards here.
 *
 * `offered` is what `ownKeyProviders` returns: with exactly one, "add your key"
 * names that provider.
 */
export function chatKeyLine(
  key: ChatKeySummary,
  ctx: { isAdmin: boolean; offered?: readonly ChatProvider[] },
): { text: string; action: { href: string; label: string } | null } {
  if (key.kind === 'team' || key.kind === 'own') {
    const route = key.via ? `${label(key.provider)} via ${label(key.via)}` : label(key.provider);
    const whose = key.kind === 'own' ? 'your key'
      : key.scope === 'workspace' ? 'workspace key'
        : key.scope === 'server' ? 'buildd key'
          : 'team key';
    return { text: `${route} · ${whose}`, action: null };
  }
  if (key.kind === 'needs_own') {
    const only = ctx.offered?.length === 1 ? ctx.offered[0] : null;
    return { text: only ? `Add your ${label(only)} key` : 'Add your own key', action: null };
  }
  return ctx.isAdmin
    ? { text: 'Not set up', action: { href: '/app/settings/models', label: 'Set it up' } }
    : { text: 'Not set up · ask an admin', action: null };
}

/**
 * Providers to offer for "use my own key": the providers the team has enabled
 * (holds a team key for), plus any you already hold a key for so you can
 * still manage it. A team with no provider key at all (usually "everyone
 * brings their own") restricts nothing, so every provider that takes personal
 * keys is offered. Only providers whose route allows personal keys ever
 * appear (a gateway such as LiteLLM never does). Display order.
 */
export function ownKeyProviders(cards: readonly Pick<ProviderCard, 'provider' | 'team' | 'mine'>[]): ChatProvider[] {
  const personal = cards.filter((c) => providerKeyCapability(c.provider)?.personalKeys === true);
  const teamEnabled = personal.some((c) => !!c.team);
  const offered = new Set(personal.filter((c) => !teamEnabled || !!c.team || !!c.mine).map((c) => c.provider));
  return CHAT_PROVIDER_INFO.map((i) => i.id).filter((id) => offered.has(id));
}
