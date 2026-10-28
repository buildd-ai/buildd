/**
 * Chat is always on, but it can't start a turn until a provider key resolves.
 * This is the one inline state for that. Nothing falls back to a subscription seat. Admins are pointed at the
 * screen that fixes it; members are told who can, or to add their own key when
 * the team's policy asks for one. The mission form is untouched either way.
 *
 * Drawn with the app's own Card and buttons, like every other page.
 */
import Link from 'next/link';
import Card from '@/components/ui/Card';

export type ChatSetupReason = 'no_key';

/** Settings screens that fix each reason. */
export const CHAT_SETTINGS_HREF = {
  teamKeys: '/app/settings/models#keys',
  ownKey: '/app/settings/account',
} as const;

/** What the create buttons need from a chat availability answer (components/chat/ChatEntry.tsx). */
export function chatEntryFromAvailability(
  avail: { available: boolean; canManageTeamKeys?: boolean } | null,
  teamId: string | null,
): { available: boolean; teamId: string | null; setupHref: string | null } {
  return {
    available: avail?.available === true,
    teamId,
    // The missing key is an owner's or admin's to fix.
    setupHref: avail && !avail.available && avail.canManageTeamKeys ? CHAT_SETTINGS_HREF.teamKeys : null,
  };
}

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
    : { title: 'Chat is not set up', body: 'Ask a team admin to connect a model provider.', cta: null, secondary: null };
}

export default function ChatSetupCard({ reason, canManage, policy }: { reason: ChatSetupReason; canManage: boolean; policy?: 'team' | 'team_or_own' | 'own' }) {
  const copy = chatSetupCopy(reason, canManage, policy);
  return (
    <Card data-testid="chat-setup-card" data-reason={reason} className="flex flex-col gap-1.5">
      <h3 data-testid="chat-setup-title" className="text-title font-semibold text-text-primary">{copy.title}</h3>
      <p className="text-body text-text-secondary">{copy.body}</p>
      {(copy.cta || copy.secondary) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          {copy.cta && (
            <Link href={copy.cta.href} data-testid="chat-setup-cta" className="btn btn-primary btn-lg no-underline">{copy.cta.label}</Link>
          )}
          {copy.secondary && (
            <Link href={copy.secondary.href} className="text-meta text-text-secondary underline hover:text-text-primary">{copy.secondary.label}</Link>
          )}
        </div>
      )}
    </Card>
  );
}
