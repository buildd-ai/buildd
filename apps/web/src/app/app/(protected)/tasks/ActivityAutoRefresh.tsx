'use client';

import { useRouter } from 'next/navigation';
import { useRegionRefresher } from '@/components/LiveRegion';
import HomeAutoRefresh from '../home/HomeAutoRefresh';

/**
 * Keeps Activity live (spec 9430a28f R-7). Every event Home follows can change
 * what is in motion here, and heartbeats that change nothing are ignored the
 * same way, so this is Home's subscriber pointed at Activity's own region read
 * (page.tsx), asked through the 5 s page gate.
 */
export default function ActivityAutoRefresh({ workspaceIds }: { workspaceIds: string[] }) {
  const refresher = useRegionRefresher(useRouter());
  return <HomeAutoRefresh workspaceIds={workspaceIds} refresher={refresher} />;
}
