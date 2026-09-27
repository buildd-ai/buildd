'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { legacySettingsTarget } from '@/lib/settings-nav';

/**
 * `/app/settings#agent-backends` and friends predate section routes. The
 * fragment never reaches the server, so the index resolves it here and
 * replaces the history entry: Back does not bounce through the index.
 */
export default function LegacyAnchorRedirect() {
  const router = useRouter();
  useEffect(() => {
    const target = legacySettingsTarget(window.location.hash);
    if (target) router.replace(target);
  }, [router]);
  return null;
}
