import Link from 'next/link';
import { resolveActionCardContext } from '@/lib/action-card-context';
import type { ActionQueueItem } from '@/lib/action-queue';

/**
 * The arc context line on a Waiting-on-You card: which initiative/mission this
 * action unblocks. Linked when the arc has a page, so the user can check why it
 * matters before merging.
 */
export function ActionCardContextLine({ item, className = '' }: { item: ActionQueueItem; className?: string }) {
  const ctx = resolveActionCardContext(item);
  if (!ctx) return null;

  const tone = ctx.kind === 'workspace' ? 'text-text-muted' : 'text-text-secondary';
  const base = `text-[11px] truncate ${tone} ${className}`.trim();

  if (ctx.href) {
    return (
      <Link href={ctx.href} className={`${base} block hover:underline`}>
        {ctx.label}
      </Link>
    );
  }
  return <div className={base}>{ctx.label}</div>;
}
