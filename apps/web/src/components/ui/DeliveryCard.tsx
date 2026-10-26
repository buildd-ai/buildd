import Link from 'next/link';
import Card from './Card';
import StageMeter from './StageMeter';
import { deliveryLabel, deliveryParts, type DeliveryRowProps } from './DeliveryRow';

export type DeliveryCardProps = DeliveryRowProps;

/**
 * Desktop Activity's delivery, for the three stage columns: the same meter,
 * title, tag and time as its DeliveryRow, read from the same `deliveryParts`,
 * on a card. Spec 9430a28f r2 R-11.
 */
export default function DeliveryCard({ delivery, now }: DeliveryCardProps) {
  const p = deliveryParts(delivery, now);
  return (
    <Card
      as={Link}
      href={delivery.href}
      interactive
      padding="sm"
      aria-label={deliveryLabel(p)}
      data-testid="delivery-card"
      data-delivery-id={delivery.id}
      className="flex flex-col gap-2 text-inherit no-underline"
    >
      <span className="flex items-center justify-between gap-2">
        <StageMeter {...p.meter} data-testid="delivery-meter" />
        <span data-testid="delivery-time" className="whitespace-nowrap font-mono text-chip text-text-secondary">{p.time}</span>
      </span>
      <span data-testid="delivery-title" className="line-clamp-3 font-sans text-title font-medium text-text-primary [overflow-wrap:break-word]">{p.title}</span>
      <span data-testid="delivery-tag" className="truncate font-mono text-chip text-text-muted">{p.tag}</span>
    </Card>
  );
}
