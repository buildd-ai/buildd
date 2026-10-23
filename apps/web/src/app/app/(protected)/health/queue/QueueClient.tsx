'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { HealthQueueFilter, HealthQueueLane, HealthQueueResponse, HealthQueueWaitingRow } from '@buildd/shared';
import PageColumn from '@/components/ui/PageColumn';
import { Select } from '@/components/ui/Select';
import QueueBoard from './QueueBoard';
import { DependencySheet, ForceStartSheet, LaneSheet } from './QueueSheets';

const ALL = 'all';

/**
 * Health › Queue (spec "Health › Queue"). The page reads the view on the
 * server; filters and paging rewrite the URL, so the server reads again, and
 * an action refreshes it. Phone and desktop render the same sections.
 */
export default function QueueClient({ view, workspaces, workspace, mission }: {
  view: HealthQueueResponse;
  workspaces: Array<{ id: string; name: string }>;
  workspace: string | null;
  mission: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [lane, setLane] = useState<HealthQueueLane | null>(null);
  const [declared, setDeclared] = useState<HealthQueueWaitingRow | null>(null);
  const [force, setForce] = useState<HealthQueueWaitingRow | null>(null);

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === ALL) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false }));
  };
  const refresh = () => startTransition(() => router.refresh());

  const workspaceOptions = [{ value: ALL, label: 'All workspaces' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))];
  const missionOptions = [{ value: ALL, label: 'All missions' }, ...view.missions.map(m => ({ value: m.id, label: m.title }))];

  return (
    <PageColumn className="px-4 pt-14 pb-24 md:pt-6" >
      <div data-testid="queue-page" className={pending ? 'opacity-60 transition-opacity' : undefined}>
        <h1 className="hidden md:block text-heading font-bold mb-4">Queue</h1>
        <div className="mb-4 flex flex-wrap gap-2">
          {workspaces.length > 1 && (
            <Select
              value={workspace ?? ALL}
              onChange={v => go({ workspace: v, mission: null, page: null })}
              options={workspaceOptions}
              aria-label="Workspace"
              size="sm"
              className="w-44"
            />
          )}
          {(view.missions.length > 0 || mission) && (
            <Select
              value={mission ?? ALL}
              onChange={v => go({ mission: v, page: null })}
              options={missionOptions}
              aria-label="Mission"
              size="sm"
              className="w-56"
            />
          )}
        </div>
        <QueueBoard
          view={view}
          onFilter={(f: HealthQueueFilter) => go({ reason: f, page: null })}
          onPage={p => go({ page: p <= 1 ? null : String(p) })}
          onOpenLane={setLane}
          onOpenRow={setDeclared}
          onForce={setForce}
        />
      </div>
      <LaneSheet lane={lane} onClose={() => setLane(null)} onDone={refresh} />
      <DependencySheet row={declared} onClose={() => setDeclared(null)} onDone={refresh} />
      <ForceStartSheet row={force} onClose={() => setForce(null)} onDone={refresh} />
    </PageColumn>
  );
}
