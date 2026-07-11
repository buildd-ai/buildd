'use client';

import { useState, useEffect } from 'react';

/**
 * Renders a timestamp as HH:MM in the *viewer's* local timezone.
 *
 * Budget/rate-limit reset times were previously shown as raw UTC
 * (`toISOString().slice(11,16)`), which is unreadable for anyone not on UTC.
 * Formatting must happen client-side: a server component would use the Vercel
 * host tz (UTC), not the viewer's. We format after mount so SSR and the first
 * client paint agree (no hydration mismatch) — before that we show the optional
 * `fallback` (e.g. the UTC value) so there's no layout jump.
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
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      setText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }
  }, [iso]);

  return (
    <span suppressHydrationWarning>
      {prefix}
      {text ?? fallback}
      {suffix}
    </span>
  );
}
