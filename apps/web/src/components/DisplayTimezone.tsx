'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { detectBrowserTimezone, formatInZone, type ZonedFormat } from '@/lib/zoned-time';

/**
 * The zone dashboard timestamps render in: the team's zone (`teams.timezone`,
 * the same source the PR activity comment stamps with), else the viewer's
 * browser zone. Never the server's — a server-rendered stamp with no zone is
 * UTC on Vercel, which is what this replaces.
 *
 * Provided by the protected layout for the current team; a page that belongs
 * to a specific team (a task, a mission) nests its own provider with that
 * team's zone.
 */
const TeamTimezoneContext = createContext<string | null>(null);

export function DisplayTimezoneProvider({
  teamTimezone,
  children,
}: {
  teamTimezone: string | null;
  children: React.ReactNode;
}) {
  return <TeamTimezoneContext.Provider value={teamTimezone}>{children}</TeamTimezoneContext.Provider>;
}

/**
 * Team zone when set — known on the server too, so SSR and hydration agree.
 * Otherwise the browser zone, read after mount; `null` until then (and during
 * SSR), so callers render nothing rather than a UTC stamp.
 */
export function useDisplayTimezone(): string | null {
  const team = useContext(TeamTimezoneContext);
  const [browser, setBrowser] = useState<string | null>(null);
  useEffect(() => {
    if (!team) setBrowser(detectBrowserTimezone());
  }, [team]);
  return team ?? browser;
}

/**
 * A timestamp in the display zone. Safe to render from server components.
 */
export function ZonedTime({
  value,
  format = 'datetime',
  fallback = '',
  className,
}: {
  value: string | number | Date;
  format?: ZonedFormat;
  /** Shown until the zone is known (no team zone, before mount). */
  fallback?: string;
  className?: string;
}) {
  const tz = useDisplayTimezone();
  const text = tz ? formatInZone(value, tz, format) : '';
  const d = new Date(value);
  return (
    <time
      dateTime={Number.isNaN(d.getTime()) ? undefined : d.toISOString()}
      className={className}
      suppressHydrationWarning
    >
      {text || fallback}
    </time>
  );
}
