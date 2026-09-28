/**
 * Chat is always on, but it can't start a turn until a provider key resolves.
 * This is the one inline state for that. Nothing falls back to a subscription seat. Admins are pointed at the
 * screen that fixes it; members are told who can, or to add their own key when
 * the team's policy asks for one. The mission form is untouched either way.
 *
 * The card is the kit's (`ChatSetupCard` from @builddai/ai-kit/chat/react);
 * the copy and the settings link are buildd's.
 */
import Link from 'next/link';
import { ChatSetupCard as KitChatSetupCard } from '@builddai/ai-kit/chat/react';

export type ChatSetupReason = 'no_key';

/** Settings screens that fix each reason. */
export const CHAT_SETTINGS_HREF = {
  teamKeys: '/app/settings/providers',
  ownKey: '/app/settings/account',
} as const;

type SetupCopy = { title: string; body: string; cta: { href: string; label: string } | null; secondary: { href: string; label: string } | null };

/**
 * The real reason and the one action that fixes it. `policy` is the team's key
 * policy: under `own`, a member's missing key is theirs to add.
 */
export function chatSetupCopy(_reason: ChatSetupReason, canManage: boolean, policy: 'team' | 'team_or_own' | 'own' = 'team'): SetupCopy {
  if (policy === 'own') {
    return { title: 'Add your key to use chat', body: 'Everyone on this team brings their own key. OpenRouter covers every model with one key.', cta: { href: CHAT_SETTINGS_HREF.ownKey, label: 'Add your key' }, secondary: null };
  }
  return canManage
    ? { title: 'Connect a model provider', body: 'Chat is where your team starts missions and asks about the fleet. It starts once the team has a key. OpenRouter covers every model with one key.', cta: { href: CHAT_SETTINGS_HREF.teamKeys, label: 'Connect a provider' }, secondary: null }
    : { title: 'Chat is not set up yet', body: 'Ask a team admin to connect a model provider.', cta: null, secondary: null };
}

export default function ChatSetupCard({ reason, canManage, policy }: { reason: ChatSetupReason; canManage: boolean; policy?: 'team' | 'team_or_own' | 'own' }) {
  const copy = chatSetupCopy(reason, canManage, policy);
  // The kit's card has one line of copy under its per-reason eyebrow ("Chat
  // needs a key"), so buildd's policy-specific title leads that line.
  return (
    <div data-testid="chat-setup-card" data-reason={reason}>
      <KitChatSetupCard
        reason={reason}
        className="buildd-setup"
        message={`${copy.title}. ${copy.body}`}
        action={(copy.cta || copy.secondary) ? (
          <>
            {copy.cta && (
              <Link href={copy.cta.href} data-testid="chat-setup-cta" className="inline-flex min-h-10 items-center border-2 border-[var(--on-accent)] bg-accent px-4 font-mono text-[13px] font-semibold text-[var(--on-accent)] hover:bg-primary-hover">
                {copy.cta.label}
              </Link>
            )}
            {copy.secondary && (
              <Link href={copy.secondary.href} className="font-mono text-[12.5px] text-text-secondary underline hover:text-text-primary">{copy.secondary.label}</Link>
            )}
          </>
        ) : undefined}
      />
    </div>
  );
}
