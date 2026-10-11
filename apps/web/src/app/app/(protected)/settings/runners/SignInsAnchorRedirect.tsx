'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Runner sign-ins moved from Runners to Models; their old anchors follow. */
export const MOVED_ANCHORS: Record<string, string> = {
  '#agent-key': '/app/settings/models#agent-key',
  '#agent-backends': '/app/settings/models#sign-ins',
};

/**
 * `/app/settings/runners#agent-key` (a failed task's "Add an agent key", old
 * bookmarks) predates the move. The fragment never reaches the server, so the
 * page resolves it here and replaces the history entry.
 */
export default function SignInsAnchorRedirect() {
  const router = useRouter();
  useEffect(() => {
    const target = MOVED_ANCHORS[window.location.hash];
    if (target) router.replace(target);
  }, [router]);
  return null;
}
