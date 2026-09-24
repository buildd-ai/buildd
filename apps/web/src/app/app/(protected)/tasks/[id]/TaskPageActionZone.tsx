'use client';

/**
 * The task sheet's `TaskActionZone` on the full task page
 * (docs/design/mission-feed-mobile-continuity.md W6: "the same component",
 * action first). The page is a server component, so the zone's `onChanged`
 * refreshes the route here.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import TaskActionZone, { type TaskActionZoneProps } from '../../missions/[id]/TaskActionZone';

export default function TaskPageActionZone(props: Omit<TaskActionZoneProps, 'onChanged'>) {
  const router = useRouter();
  const onChanged = useCallback(() => router.refresh(), [router]);
  return <TaskActionZone {...props} onChanged={onChanged} />;
}
