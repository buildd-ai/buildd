/**
 * Chat can't start a turn: no provider key resolves, or the team hasn't turned
 * the `chat` capability on. Nothing falls back to a subscription seat. Admins
 * are pointed at the screen that fixes it; members are told who can, or to use
 * their own key. The mission form is untouched either way.
 */
import Link from 'next/link';

export type ChatSetupReason = 'capability_disabled' | 'no_key';

/** Settings screens (the settings UI's own anchors). */
export const CHAT_SETTINGS_HREF = {
  capability: '/app/settings#inference-spending',
  teamKeys: '/app/settings/models#provider-keys',
  ownKey: '/app/you#provider-keys',
} as const;

export function chatSetupCopy(reason: ChatSetupReason, canManage: boolean): { title: string; body: string; cta: { href: string; label: string } | null; secondary: { href: string; label: string } | null } {
  if (canManage) {
    return reason === 'capability_disabled'
      ? {
          title: 'Turn on chat for your team',
          body: 'Chat runs on your team’s API key, billed per token, never on a subscription seat. It’s off until you turn it on.',
          cta: { href: CHAT_SETTINGS_HREF.capability, label: 'Turn on chat' },
          secondary: { href: CHAT_SETTINGS_HREF.teamKeys, label: 'Provider keys' },
        }
      : {
          title: 'Add a team key to use chat',
          body: 'Chat needs an Anthropic, OpenAI or OpenRouter API key. Subscription seats can’t run chat turns.',
          cta: { href: CHAT_SETTINGS_HREF.teamKeys, label: 'Add a team key' },
          secondary: null,
        };
  }
  return reason === 'capability_disabled'
    ? {
        title: 'Chat is off for your team',
        body: 'Ask a team admin to turn it on. Until then, file work with the mission form.',
        cta: null,
        secondary: null,
      }
    : {
        title: 'Chat needs a provider key',
        body: 'Ask an admin to connect a provider, or use your own key.',
        cta: { href: CHAT_SETTINGS_HREF.ownKey, label: 'Use my own key' },
        secondary: null,
      };
}

export default function ChatSetupCard({ reason, canManage }: { reason: ChatSetupReason; canManage: boolean }) {
  const copy = chatSetupCopy(reason, canManage);
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
