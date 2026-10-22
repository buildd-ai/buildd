'use client';

/**
 * The Build stage's list (Navigation d25d923d R-5, R-14): one summary line
 * under the bar and one row per unfinished build task, named, never
 * numbered, leading with what needs a person, then running, fixing, waiting
 * and queued; merged tasks fold into `11 merged ›`. From 20 waiting tasks
 * the waiting rows group by what they wait on. Every row opens its task page.
 *
 * ```
 * 11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting
 * Mirror the runner image to Docker Hub      Your decision        1m ago
 * Redeploy keeps the dispatch token          Running 12m · writing the test · updated 14s ago
 * The release publishes an image digest      Waiting on Mirror the runner image…
 * 11 merged ›
 * ```
 *
 * The rows come from `buildStage` (lib/mission-build-stage.ts); this draws
 * them. A row carries `missionTaskAnchorId`, so a `#t-<id>` link lands on it.
 */
import Link from 'next/link';
import { useState } from 'react';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { buildStage, mergedFoldLine, type BuildStageRow } from '@/lib/mission-build-stage';
import type { MissionBoardModel } from '@/lib/mission-board';
import { missionTaskAnchorId } from '@/lib/mission-task-href';
import { displayTaskTitle } from '@/lib/task-title';

export interface MissionBuildStageProps {
  model: MissionBoardModel;
  now: number;
  hrefFor: (taskId: string) => string;
  /** A `#t-<id>` arrival: the merged fold opens when it names a merged task. */
  revealTaskId?: string | null;
}

const DOT: Record<BuildStageRow['tone'], string> = {
  dec: 'bg-status-warning',
  bad: 'bg-status-error',
  act: 'bg-status-running',
  q: 'bg-[var(--faint)]',
};

const ROW = 'grid min-h-11 grid-cols-[minmax(0,1fr)] items-start gap-x-4 gap-y-0.5 border-t border-[var(--line-soft)] py-2.5 text-body hover:bg-card-hover md:grid-cols-[minmax(0,1fr)_minmax(0,46%)_auto] md:items-baseline';

/** `resumes 05:26` in the team's zone, else the browser's. */
function useClock(): (ts: number) => string {
  const tz = useDisplayTimezone();
  return (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) });
}

export default function MissionBuildStage({ model, now, hrefFor, revealTaskId = null }: MissionBuildStageProps) {
  const clock = useClock();
  const stage = buildStage(model, now, { hrefFor, clock });
  const [mergedOpen, setMergedOpen] = useState(false);
  const reveal = revealTaskId != null && stage.merged.ids.includes(revealTaskId);
  const showMerged = mergedOpen || reveal;
  const listed = stage.waitingGroups ? stage.rows.filter(r => r.state !== 'waiting') : stage.rows;
  return (
    <section data-testid="mission-build-stage" aria-label="Build" className="flex min-w-0 flex-col gap-2">
      <p data-testid="mission-build-summary" className="font-mono text-meta text-text-muted [overflow-wrap:anywhere]">{stage.summary}</p>
      {(listed.length > 0 || stage.waitingGroups || stage.merged.count > 0) && (
        <ul data-testid="mission-task-list" className="flex min-w-0 flex-col">
          {listed.map(r => <Row key={r.id} row={r} />)}
          {stage.waitingGroups?.map(g => (
            <li key={g.blockerId} data-testid="mission-waiting-group" className={ROW}>
              <span className="min-w-0 text-text-primary [overflow-wrap:anywhere]">{g.line}</span>
              <span className="font-mono text-meta text-text-muted md:text-right">{g.ids.length === 1 ? '1 task' : `${g.ids.length} tasks`}</span>
            </li>
          ))}
          {stage.merged.count > 0 && (
            <li data-testid="mission-merged-fold" className="border-t border-[var(--line-soft)]">
              <button
                type="button"
                aria-expanded={showMerged}
                data-testid="mission-merged-toggle"
                onClick={() => setMergedOpen(v => !v)}
                className="flex min-h-11 w-full items-center gap-2 text-left text-body text-text-secondary hover:text-text-primary"
              >
                <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT.q} bg-status-success`} />
                {mergedFoldLine(stage.merged.count)}
              </button>
              {showMerged && (
                <ul data-testid="mission-merged-list" className="flex flex-col pb-2">
                  {stage.merged.ids.map(id => (
                    <li key={id} id={missionTaskAnchorId(id)} data-task-id={id} data-testid="mission-task-row" data-state="merged" className="flex min-h-11 items-center">
                      <Link href={hrefFor(id)} className="min-w-0 flex-1 truncate pl-4 text-body text-text-secondary underline-offset-4 hover:text-text-primary hover:underline">{displayTaskTitle(model.tasks[id].title)}</Link>
                      <span className="shrink-0 font-mono text-meta text-text-muted">Merged</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function Row({ row }: { row: BuildStageRow }) {
  return (
    <li id={missionTaskAnchorId(row.id)} data-task-id={row.id} data-testid="mission-task-row" data-state={row.state} className="relative">
      <Link href={row.href} className={ROW}>
        <span className="flex min-w-0 items-baseline gap-2">
          <span aria-hidden="true" className={`mt-[0.45em] inline-block h-2 w-2 shrink-0 rounded-full ${DOT[row.tone]}`} />
          <span className="min-w-0 text-text-primary [overflow-wrap:anywhere]">{displayTaskTitle(row.title)}</span>
        </span>
        <span data-testid="mission-task-state" className={`min-w-0 pl-4 font-mono text-meta [overflow-wrap:anywhere] md:pl-0 ${row.tone === 'dec' ? 'font-semibold text-status-warning' : row.tone === 'bad' ? 'font-semibold text-status-error' : row.tone === 'act' ? 'text-accent-text' : 'text-text-muted'}`}>
          {row.line}
          {row.detail && <span className="block text-text-muted">{row.detail}</span>}
        </span>
        {row.age && <span className="hidden shrink-0 font-mono text-meta text-text-muted md:block">{row.age}</span>}
      </Link>
    </li>
  );
}

export { MissionBuildStage };
