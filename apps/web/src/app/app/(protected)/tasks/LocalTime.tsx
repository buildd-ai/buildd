'use client';

import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';

/**
 * Renders a timestamp as HH:MM in the display zone — the team's zone, else the
 * viewer's browser zone (see `useDisplayTimezone`).
 *
 * Budget/rate-limit reset times were previously shown as raw UTC
 * (`toISOString().slice(11,16)`), which is unreadable for anyone not on UTC.
 * With a team zone the string is known on the server, so SSR and hydration
 * agree. Without one the zone is only known after mount; until then we show
 * the optional `fallback` (e.g. the UTC value) so there's no layout jump.
 */
export default function LocalTime({
  iso,
  prefix = '',
  suffix = '',
  fallback = '',
}: {
  iso: string;
  prefix?: string;
  suffix?: string;
  fallback?: string;
}) {
  const tz = useDisplayTimezone();
  const text = tz ? formatInZone(iso, tz, { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <span suppressHydrationWarning>
      {prefix}
      {text || fallback}
      {suffix}
    </span>
  );
}
