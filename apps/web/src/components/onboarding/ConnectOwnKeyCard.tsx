'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import ConnectOpenRouterButton, { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';

/**
 * A team where everyone brings their own key: the person has none yet. One
 * card, one button, no settings trip. Shown on Home and in place of chat.
 */
export default function ConnectOwnKeyCard({ teamId, returnTo }: { teamId: string; returnTo: string }) {
  const flow = providerFlowMessage(useSearchParams());
  return (
    <section data-testid="connect-own-key" className="mb-8 border-2 border-border-strong bg-card px-5 py-4 shadow-[var(--card-shadow)]">
      <div className="section-label !text-accent-text">Agent chat</div>
      <h2 className="mt-1.5 text-[17px] font-semibold text-text-primary">Connect OpenRouter to start</h2>
      <p className="mt-1 text-sm text-text-secondary">Your team has everyone bring their own key. OpenRouter makes one in your account, and your chats bill to it.</p>
      {flow && (
        <p role={flow.tone === 'err' ? 'alert' : 'status'} className={`mt-2 text-sm ${flow.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{flow.text}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <ConnectOpenRouterButton scope="user" teamId={teamId} returnTo={returnTo} />
        <Link href="/app/settings/account" className="text-xs text-text-secondary underline hover:text-text-primary">Paste a key instead</Link>
      </div>
    </section>
  );
}
