import Link from 'next/link';
import Lede from '@/components/ui/Lede';
import type { SpecListItem } from '@/lib/specs/page-view';

function Row({ item }: { item: SpecListItem }) {
  return (
    <li data-testid="spec-list-item" data-spec-id={item.id}>
      <Link
        href={`/app/specs/${item.id}`}
        className="flex min-h-11 flex-col justify-center gap-0.5 px-2 py-2 hover:bg-surface-2"
      >
        <span className="text-body font-medium text-text-primary [overflow-wrap:anywhere]">{item.title}</span>
        <span className="text-meta text-text-muted" data-testid="spec-list-standing">
          {item.scope} · {item.standing} · updated {item.updatedAgo}
        </span>
        {item.waiting ? (
          <span className="text-meta text-status-warning" data-testid="spec-list-waiting">
            Revision {item.waiting} waiting for approval
          </span>
        ) : null}
      </Link>
      {item.children.length ? (
        <ul className="ml-3 border-l border-[var(--line-soft)] pl-2" data-testid="spec-list-children">
          {item.children.map((c) => <Row key={c.id} item={c} />)}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A workspace's specs as a tree (living-specs.md §9): each row says in words
 * what it is, where it stands and whether a revision waits for approval. No
 * counts; an empty workspace says how specs get made.
 */
export default function SpecList({ specs }: { specs: SpecListItem[] }) {
  if (specs.length === 0) {
    return (
      <Lede>
        <span data-testid="spec-list-empty">
          No specs. Agents draft them over MCP or in chat, and each one appears here for you to read and approve.
        </span>
      </Lede>
    );
  }
  return (
    <ul className="flex flex-col" data-testid="spec-list">
      {specs.map((s) => <Row key={s.id} item={s} />)}
    </ul>
  );
}
