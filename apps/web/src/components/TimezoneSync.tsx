'use client';

import { useEffect } from 'react';

/**
 * Reports the browser's timezone to the server once, when it differs from what
 * we already have stored for this user.
 *
 * Renders nothing. This exists so nobody has to tell buildd where they are —
 * `Intl` already knows, and every feature that needs a zone (PR activity comments,
 * schedule defaults, mission active hours) would otherwise silently assume UTC.
 *
 * Fires only on a real difference, so steady-state navigation costs no requests;
 * a move or a new laptop corrects itself on the next page load.
 */
export default function TimezoneSync({ knownTimezone }: { knownTimezone: string | null }) {
  useEffect(() => {
    let detected: string | undefined;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!detected || detected === knownTimezone) return;

    // Best-effort: a failure here just means we try again on the next load.
    fetch('/api/me/timezone', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: detected }),
    }).catch(() => {});
  }, [knownTimezone]);

  return null;
}
