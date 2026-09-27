'use client';

/**
 * Chat on Home: the first thing on the page for everyone, because chat is
 * how work starts (lib/chat/entry-points.ts). The composer, then recent chats;
 * operators get the fleet directly underneath. The first send creates the
 * conversation and continues on its page.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ChatTierName, CreateConversationResponse } from '@buildd/shared';
import ChatComposer, { type ComposerWorkspace } from './ChatComposer';
import { parkPending } from './pending-message';
import { chatErrorLine } from './chat-errors';
import type { ConversationListItem } from '@/lib/chat/conversations';

export default function HomeChatCard({
  teamId, workspaces, recent, agentName = 'Organizer', compact = false, initialWorkspaceId = null,
}: {
  teamId: string;
  workspaces: readonly ComposerWorkspace[];
  recent: readonly ConversationListItem[];
  agentName?: string;
  /** Operators: fewer recent chats, so the fleet stays on the first screen. */
  compact?: boolean;
  /** Home's workspace filter, when it names one of these workspaces. */
  initialWorkspaceId?: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    (initialWorkspaceId && workspaces.some(w => w.id === initialWorkspaceId) ? initialWorkspaceId : null) ?? workspaces[0]?.id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [pinnedTier, setPinnedTier] = useState<ChatTierName | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(text: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, workspaceId, tier: pinnedTier }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { conversation } = (await res.json()) as CreateConversationResponse;
      parkPending(conversation.id, text);
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
        value={draft}
        onChange={setDraft}
        onSend={send}
        busy={busy}
        disabled={busy}
        placeholder="Describe the work, or ask about your fleet…"
        workspaces={workspaces}
        workspaceId={workspaceId}
        onWorkspaceChange={setWorkspaceId}
        tier={null}
        teamId={teamId}
        pinnedTier={pinnedTier}
        onTierChange={setPinnedTier}
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
