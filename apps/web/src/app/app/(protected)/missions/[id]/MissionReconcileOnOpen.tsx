'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Fires one PR-state reconcile when the mission page opens, then refreshes if
 * anything was corrected.
 *
 * Deliberately reconcile-only: opening a mission must NOT trigger a planning
 * pass. Planning costs an agent run, and tying progress to someone looking at
 * the page would turn unattended orchestration into attended orchestration.
 * The cron owns the clock; presence only keeps state honest — which is the
 * actual failure mode, since a single missed webhook could leave a merged PR
 * recorded as open forever and silently block every dependent task.
 */
export default function MissionReconcileOnOpen({ missionId }: { missionId: string }) {
  const router = useRouter();
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    if (ranFor.current === missionId) return;
    ranFor.current = missionId;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/missions/${missionId}/reconcile`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => ({ corrected: 0 }));
        if (data.corrected > 0 && !cancelled) {
          console.log(`[pr-reconcile] corrected ${data.corrected} stale PR state(s)`);
          router.refresh();
        }
      } catch {
        // Best effort — a failed reconcile must never break the page.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [missionId, router]);

  return null;
}
