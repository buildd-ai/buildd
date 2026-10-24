import Link from 'next/link';
import { termWord } from '@buildd/shared';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import { QUEUE_REASON_TERM, type QueueReason } from './QueueTiles';

export interface QueueRowProps {
  title: string;
  /** Mission title, or null for standalone work. */
  mission?: string | null;
  /** The one reason, from the claim route's own query. */
  reason: QueueReason;
  /** The claim route's own text: `Schema lane · 2nd`, `1/h · lifts 14:00`, or the blocking task. */
  blockedBy: string;
  /** A Dependency row's blocker status: the existing square dot, in the status colour. */
  blockedByDot?: ChipTone;
  age: string;
  href: string;
  /** Wide row on desktop, two lines on a phone. */
  layout?: 'phone' | 'desktop';
}

const DOT_TEXT: Record<ChipTone, string> = {
  success: 'text-status-success',
  running: 'text-status-running',
  warning: 'text-status-warning',
  error: 'text-status-error',
  info: 'text-status-info',
  accent: 'text-accent-text',
  muted: 'text-text-muted',
};

const CHIP_TONE: Record<QueueReason, ChipTone> = { lane: 'muted', limit: 'warning', dependency: 'info' };

export function ReasonBadge({ reason }: { reason: QueueReason }) {
  return (
    <Chip
      tone={CHIP_TONE[reason]}
      data-testid="queue-reason"
    >
      {termWord(QUEUE_REASON_TERM[reason])}
    </Chip>
  );
}

function BlockedBy({ text, dot }: { text: string; dot?: ChipTone }) {
  return (
    <span data-testid="queue-blocked-by" className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-text-secondary">
      {dot && <span aria-hidden="true" data-testid="queue-blocked-by-dot" className={`h-1.5 w-1.5 shrink-0 bg-current ${DOT_TEXT[dot]}`} />}
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * One blocked task (spec 4bc3e70e R-5, R-6): title, one reason badge, Blocked by,
 * age. Everything is a prop: the reason and its text come from the claim
 * route's own query and are never re-derived here.
 */
export default function QueueRow({ title, mission, reason, blockedBy, blockedByDot, age, href, layout = 'phone' }: QueueRowProps) {
  const base = 'block border-t border-border-default py-2.5 text-text-primary no-underline min-h-[44px]';
  if (layout === 'desktop') {
    return (
      <Link href={href} data-testid="queue-row" data-layout="desktop" className={`${base} grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_minmax(0,1.5fr)_auto] items-center gap-4`}>
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-text-muted">{mission ?? 'standalone'}</span>
        <ReasonBadge reason={reason} />
        <BlockedBy text={blockedBy} dot={blockedByDot} />
        <span className="text-right font-mono text-xs text-text-muted">{age}</span>
      </Link>
    );
  }
  return (
    <Link href={href} data-testid="queue-row" data-layout="phone" className={`${base} grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5`}>
      <span className="col-span-2 truncate text-sm font-medium">{title}</span>
      <span className="text-right font-mono text-xs text-text-muted">{age}</span>
      <ReasonBadge reason={reason} />
      <BlockedBy text={blockedBy} dot={blockedByDot} />
      {mission ? <span className="max-w-[140px] truncate text-right text-xs text-text-muted">{mission}</span> : <span />}
    </Link>
  );
}
