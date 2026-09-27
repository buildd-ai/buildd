import Link from 'next/link';
import { ZonedTime } from '@/components/DisplayTimezone';
import type { ConversationListItem } from '@/lib/chat/conversations';

/**
 * The conversation list: auto titles, newest first. Above the new-chat canvas
 * on desktop; a phone's history view (/app/chat?view=history) on a phone.
 * The heading is the screen's mono overline, like `PICKED FOR YOU`.
 */
export default function ConversationList({ items, currentId }: { items: readonly ConversationListItem[]; currentId?: string | null }) {
  if (items.length === 0) return null;
  return (
    <nav data-testid="conversation-list" aria-label="Conversations" className="mb-8">
      <div data-testid="conversation-list-heading" className="mb-2 px-1 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)]">Recent</div>
      <ul className="divide-y divide-[var(--chat-rule)] border border-[var(--chat-rule)] bg-[var(--chat-panel)]">
        {items.map(c => (
          <li key={c.id}>
            <Link
              href={`/app/chat/${c.id}`}
              aria-current={c.id === currentId ? 'page' : undefined}
              className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-[var(--convo-soft)]"
            >
              <span className={`min-w-0 flex-1 truncate font-convo text-[14.5px] ${c.untitled ? 'text-text-muted' : 'font-medium text-text-primary'}`}>{c.title}</span>
              <ZonedTime value={c.lastMessageAt} format="datetime-short" className="shrink-0 font-mono text-[11.5px] text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
