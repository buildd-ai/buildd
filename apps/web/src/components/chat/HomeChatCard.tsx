'use client';

/**
 * Chat on Home: the first thing on the page for everyone, because chat is
 * how work starts (lib/chat/entry-points.ts). The composer, then recent chats;
 * operators get the fleet directly underneath. The first send creates the
 * conversation and continues on its page.
 *
 * The draft, workspace and tier are the shared composer's (composer-store.ts):
 * the same ones /app/chat and the canvas show, seeded from your last choices.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CreateConversationResponse } from '@buildd/shared';
import ChatComposer, { type ComposerWorkspace } from './ChatComposer';
import { parkPending } from './pending-message';
import { chatErrorLine } from './chat-errors';
import { useSharedComposer } from './composer-store';
import type { ConversationListItem } from '@/lib/chat/conversations';

export default function HomeChatCard({
  teamId, workspaces, recent, agentName = 'buildd', compact = false, initialWorkspaceId = null,
}: {
  teamId: string;
  workspaces: readonly ComposerWorkspace[];
  recent: readonly ConversationListItem[];
  agentName?: string;
  /** Operators: fewer recent chats, so the fleet stays on the first screen. */
  compact?: boolean;
  /** The app-wide workspace selection (?workspace=), when it names one of these. Else the remembered one. */
  initialWorkspaceId?: string | null;
}) {
  const router = useRouter();
  const composer = useSharedComposer(teamId, workspaces, initialWorkspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(text: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, workspaceId: composer.workspaceId, tier: composer.tier }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { conversation } = (await res.json()) as CreateConversationResponse;
      parkPending(conversation.id, text);
      composer.setDraft('');
      router.push(`/app/chat/${conversation.id}`);
    } catch (e) {
      setError(chatErrorLine(e));
      setBusy(false);
    }
  }

  return (
    <section data-testid="home-chat-card" className="mb-6">
      <div className="mb-3 flex items-center justify-between font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
        <span>{`Ask ${agentName}`}</span>
        <Link href="/app/chat" className="hover:text-text-primary">All chats →</Link>
      </div>
      <ChatComposer
        value={composer.draft}
        onChange={composer.setDraft}
        onSend={send}
        busy={busy}
        disabled={busy}
        placeholder="Describe the work, or ask about your fleet…"
        workspaces={workspaces}
        workspaceId={composer.workspaceId}
        onWorkspaceChange={composer.setWorkspaceId}
        tier={null}
        teamId={teamId}
        pinnedTier={composer.tier}
        onTierChange={composer.setTier}
        compact
      />
      {error && <p role="alert" className="mt-2 font-mono text-[12px] text-status-error">{error}</p>}
      {recent.length > 0 && (
        <ul data-testid="home-chat-recent" className="mt-3 grid gap-1">
          {recent.slice(0, compact ? 2 : 3).map(c => (
            <li key={c.id}>
              <Link href={`/app/chat/${c.id}`} className="flex min-h-10 items-center gap-2 font-mono text-[12.5px] text-text-secondary hover:text-text-primary">
                <span aria-hidden="true" className="text-text-muted">↳</span>
                <span className="min-w-0 truncate">{c.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
