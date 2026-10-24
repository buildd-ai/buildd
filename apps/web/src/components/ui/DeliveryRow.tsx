import Link from 'next/link';
import type { NowRow } from '@/lib/activity-delivery';
import StageMeter, { stageMeterName, type StageMeterStage, type StageMeterState } from './StageMeter';

/**
 * One delivery as Activity draws it, already projected: the row's own fields
 * come from the shared delivery projection (`NowRow`), the meter reading and
 * the failing check are the caller's from that same projection. Nothing is
 * derived here beyond which of the two the tag shows.
 */
export interface DeliveryItem extends Pick<NowRow, 'id' | 'title' | 'href' | 'updatedAt'> {
  meter: { state: StageMeterState; stage?: StageMeterStage; fixRounds?: number };
  /** The mission's title; null for standalone work. */
  missionTitle: string | null;
  /** The check the fix is for (`CI failed`), while the delivery is being fixed. */
  failingCheck: string | null;
}

const FIXING: ReadonlySet<StageMeterState> = new Set(['fixing-in-build', 'fixing-in-verify']);

export const STANDALONE_TAG = 'standalone';

/**
 * The one tag: the mission, or while the delivery is being fixed, the check
 * that failed beside it. Once the fix lands the meter leaves its fixing state
 * and the tag is the mission again. Spec 9430a28f r2 AC-9.
 */
export function deliveryTag(d: DeliveryItem): string {
  const mission = d.missionTitle ?? STANDALONE_TAG;
  return FIXING.has(d.meter.state) && d.failingCheck ? `${mission} · ${d.failingCheck}` : mission;
}

/** `now`, `4m`, `5h`, `3d`: how long since the delivery last moved. */
export function deliveryAgo(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 60_000) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The four things a row and a card both show, from one place so they cannot disagree (AC-10). */
export function deliveryParts(d: DeliveryItem, now: number) {
  const stage = d.meter.stage;
  return {
    meter: { state: d.meter.state, stage, fixRounds: d.meter.fixRounds ?? 0 },
    title: d.title,
    tag: deliveryTag(d),
    time: deliveryAgo(d.updatedAt, now),
  };
}

/** Accessible name for the whole link: title, where it is, the tag, the time. */
export function deliveryLabel(parts: ReturnType<typeof deliveryParts>): string {
  const { state, stage, fixRounds } = parts.meter;
  const where = stageMeterName(state, stage ?? 'build', fixRounds);
  return `${parts.title}. ${where}. ${parts.tag}. ${parts.time === 'now' ? 'Just now' : `${parts.time} ago`}`;
}

export interface DeliveryRowProps {
  delivery: DeliveryItem;
  /** Epoch ms the time is measured from. */
  now: number;
}

/**
 * Phone Activity's delivery: StageMeter, title, one mono tag, the time. Nothing
 * else (no mission header, New pill, sha, actor or sentence); that detail is on
 * the task page the row links to. Spec 9430a28f r2 R-10.
 */
export default function DeliveryRow({ delivery, now }: DeliveryRowProps) {
  const p = deliveryParts(delivery, now);
  return (
    <Link
      href={delivery.href}
      aria-label={deliveryLabel(p)}
      data-testid="delivery-row"
      data-delivery-id={delivery.id}
      className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-border-default py-2 text-inherit no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <StageMeter {...p.meter} data-testid="delivery-meter" />
      <span className="flex min-w-0 flex-col gap-px">
        <span data-testid="delivery-title" title={p.title} className="truncate font-sans text-title font-medium text-text-primary">{p.title}</span>
        <span data-testid="delivery-tag" className="truncate font-mono text-chip text-text-muted">{p.tag}</span>
      </span>
      <span data-testid="delivery-time" className="whitespace-nowrap font-mono text-chip text-text-secondary">{p.time}</span>
    </Link>
  );
}
