/**
 * Chat can't start a turn: no provider key resolves, or an admin switched chat
 * off. Nothing falls back to a subscription seat. Admins are pointed at the
 * screen that fixes it; members are told who can, or to add their own key when
 * the team's policy asks for one. The mission form is untouched either way.
 */
import Link from 'next/link';

export type ChatSetupReason = 'capability_disabled' | 'no_key';

/** Settings screens that fix each reason. */
export const CHAT_SETTINGS_HREF = {
  capability: '/app/settings/ai',
  teamKeys: '/app/settings/providers',
  ownKey: '/app/settings/account',
} as const;

type SetupCopy = { title: string; body: string; cta: { href: string; label: string } | null; secondary: { href: string; label: string } | null };

/**
 * The real reason and the one action that fixes it. `policy` is the team's key
 * policy: under `own`, a member's missing key is theirs to add.
 */
export function chatSetupCopy(reason: ChatSetupReason, canManage: boolean, policy: 'team' | 'team_or_own' | 'own' = 'team'): SetupCopy {
  if (reason === 'capability_disabled') {
    return canManage
      ? { title: 'Chat is off for your team', body: 'You switched it off in AI features.', cta: { href: CHAT_SETTINGS_HREF.capability, label: 'Turn chat on' }, secondary: null }
      : { title: 'Chat is off for your team', body: 'An admin switched it off. File work with the mission form until then.', cta: null, secondary: null };
  }
  if (policy === 'own') {
    return { title: 'Add your key to use chat', body: 'Everyone on this team brings their own key. OpenRouter covers every model with one key.', cta: { href: CHAT_SETTINGS_HREF.ownKey, label: 'Add your key' }, secondary: null };
  }
  return canManage
    ? { title: 'Connect a model provider', body: 'Chat is where your team starts missions and asks about the fleet. It starts once the team has a key. OpenRouter covers every model with one key.', cta: { href: CHAT_SETTINGS_HREF.teamKeys, label: 'Connect a provider' }, secondary: null }
    : { title: 'Chat is not set up yet', body: 'Ask a team admin to connect a model provider.', cta: null, secondary: null };
}

export default function ChatSetupCard({ reason, canManage, policy }: { reason: ChatSetupReason; canManage: boolean; policy?: 'team' | 'team_or_own' | 'own' }) {
  const copy = chatSetupCopy(reason, canManage, policy);
  return (
    <section data-testid="chat-setup-card" data-reason={reason} className="border-2 border-dashed border-border-strong bg-card px-5 py-4">
      <div className="font-mono text-[11px] font-bold uppercase tracking-[2px] text-accent-text">Agent chat</div>
      <h2 className="mt-1.5 font-mono text-[16px] font-semibold text-text-primary">{copy.title}</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-text-secondary">{copy.body}</p>
      {(copy.cta || copy.secondary) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {copy.cta && (
            <Link href={copy.cta.href} data-testid="chat-setup-cta" className="inline-flex min-h-10 items-center border-2 border-[var(--on-accent)] bg-accent px-4 font-mono text-[13px] font-semibold text-[var(--on-accent)] hover:bg-primary-hover">
              {copy.cta.label}
            </Link>
          )}
          {copy.secondary && (
            <Link href={copy.secondary.href} className="font-mono text-[12.5px] text-text-secondary underline hover:text-text-primary">{copy.secondary.label}</Link>
          )}
        </div>
      )}
    </section>
  );
}
