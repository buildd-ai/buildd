'use client';

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { HealthQueueFilter, HealthQueueLane, HealthQueueResponse, HealthQueueWaitingRow } from '@buildd/shared';
import PageColumn from '@/components/ui/PageColumn';
import { Select } from '@/components/ui/Select';
import { publishQueueWaitingCount } from '@/lib/health-queue-count';
import QueueBoard from './QueueBoard';
import { DependencySheet, LaneSheet } from './QueueSheets';
import QueueStartSheet from './QueueStartSheet';

const ALL = 'all';
/** The query param a Dependency row's link sets to open its sheet here. */
export const OPEN_PARAM = 'open';

/**
 * Health › Queue (spec 4bc3e70e r8). The page reads the view on the server;
 * filters and paging rewrite the URL, so the server reads again, and an action
 * refreshes it. A Dependency row links to `?open=<task>`, which opens its
 * sheet; every other row links to its task. Phone and desktop render the same
 * sections.
 */
export default function QueueClient({ view, workspaces, workspace, mission, now }: {
  view: HealthQueueResponse;
  workspaces: Array<{ id: string; name: string }>;
  workspace: string | null;
  mission: string | null;
  /** The read's clock (epoch ms), so server and client render the same times. */
  now: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [lane, setLane] = useState<HealthQueueLane | null>(null);
  const [starting, setStarting] = useState<HealthQueueWaitingRow | null>(null);

  // R-1: the tab's count comes from this read, not a second one.
  useEffect(() => { publishQueueWaitingCount(view.tiles.waiting, workspace); }, [view.tiles.waiting, workspace]);

  const urlWith = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === ALL) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  };
  const go = (changes: Record<string, string | null>) => startTransition(() => router.replace(urlWith(changes), { scroll: false }));
  const refresh = () => startTransition(() => router.refresh());

  const openId = params.get(OPEN_PARAM);
  const declared = openId ? view.waiting.rows.find(r => r.id === openId && r.reason === 'declared') ?? null : null;
  const hrefFor = (row: HealthQueueWaitingRow) => (row.reason === 'declared' ? urlWith({ [OPEN_PARAM]: row.id }) : `/app/tasks/${row.id}`);

  const workspaceOptions = [{ value: ALL, label: 'All workspaces' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))];
  const missionOptions = [{ value: ALL, label: 'All missions' }, ...view.missions.map(m => ({ value: m.id, label: m.title }))];

  return (
    <PageColumn className="px-4 pt-14 pb-24 md:pt-6">
      <div data-testid="queue-page" className={`min-w-0 ${pending ? 'opacity-60 transition-opacity' : ''}`}>
        <h1 className="hidden md:block text-heading font-bold mb-4">Queue</h1>
        {(workspaces.length > 1 || view.missions.length > 0 || mission) && (
          <div className="mb-4 flex flex-wrap gap-2">
            {workspaces.length > 1 && (
              <Select
                value={workspace ?? ALL}
                onChange={v => go({ workspace: v, mission: null, page: null, [OPEN_PARAM]: null })}
                options={workspaceOptions}
                aria-label="Workspace"
                size="sm"
                className="w-44 max-w-full"
              />
            )}
            {(view.missions.length > 0 || mission) && (
              <Select
                value={mission ?? ALL}
                onChange={v => go({ mission: v, page: null, [OPEN_PARAM]: null })}
                options={missionOptions}
                aria-label="Mission"
                size="sm"
                className="w-56 max-w-full"
              />
            )}
          </div>
        )}
        <QueueBoard
          view={view}
          now={now}
          onFilter={(f: HealthQueueFilter) => go({ reason: f, page: null })}
          onPage={p => go({ page: p <= 1 ? null : String(p) })}
          onOpenLane={setLane}
          onStart={setStarting}
          hrefFor={hrefFor}
        />
      </div>
      <LaneSheet lane={lane} onClose={() => setLane(null)} onDone={refresh} />
      <DependencySheet row={declared} onClose={() => go({ [OPEN_PARAM]: null })} onDone={refresh} />
      <QueueStartSheet row={starting} onClose={() => setStarting(null)} onDone={refresh} />
    </PageColumn>
  );
}
