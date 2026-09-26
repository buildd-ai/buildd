'use client';

/**
 * Chat on Home (docs/design/agent-chat.md, "Who sees what first"): a member's
 * home opens on the conversation — the composer, then their recent chats. The
 * first send creates the conversation and continues on its page.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CreateConversationResponse } from '@buildd/shared';
import ChatComposer, { type ComposerWorkspace } from './ChatComposer';
import { parkPending } from './pending-message';
import { chatErrorLine } from './chat-errors';
import type { ConversationListItem } from '@/lib/chat/conversations';

export default function HomeChatCard({
  teamId, workspaces, recent, agentName = 'Organizer', compact = false,
}: {
  teamId: string;
  workspaces: readonly ComposerWorkspace[];
  recent: readonly ConversationListItem[];
  agentName?: string;
  /** Operators: the fleet stays first, chat is one card among the rest. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaces[0]?.id ?? null);
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
        body: JSON.stringify({ teamId, workspaceId }),
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
    <section data-testid="home-chat-card" className="mb-8">
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
        placeholder={compact ? 'Ask about your fleet…' : 'Ask about your fleet, or describe the work…'}
        workspaces={workspaces}
        workspaceId={workspaceId}
        onWorkspaceChange={setWorkspaceId}
        tier={null}
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
