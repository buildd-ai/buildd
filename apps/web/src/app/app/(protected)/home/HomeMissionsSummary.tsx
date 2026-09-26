/**
 * Home's compact MISSIONS block: one row per running, recurring or
 * just-shipped mission — status word, title, the small phase bar (or the
 * recurring chip + run pips), and the live/n/N/next facts. The full cards live
 * on /app/missions; these rows share their model (lib/mission-list-card.ts).
 */
import Link from 'next/link';
import PhaseBar from '@/components/missions/PhaseBar';
import { StatusWord } from '@/components/missions/MissionListCards';
import type { MissionCardView } from '@/lib/mission-card-view';
import { shortDuration, type MissionListCardModel } from '@/lib/mission-list-card';

export interface HomeMissionRow {
  view: MissionCardView;
  model: MissionListCardModel;
}

const RUN_PIP: Record<'ok' | 'fail' | 'live' | 'pending', string> = {
  ok: 'border-status-success bg-status-success',
  fail: 'border-status-error bg-status-error',
  live: 'border-accent bg-accent',
  pending: 'border-border-strong',
};

function nextLabel(mins: number | null): string | null {
  if (mins == null) return null;
  if (mins <= 0) return 'due now';
  return mins >= 90 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

function Row({ view, model }: HomeMissionRow) {
  const r = model.recurring;
  const status = r ? { label: 'Recurring', tone: 'muted' as const } : model.kind === 'done'
    ? { label: model.done?.durationMs != null ? `Done · ${shortDuration(model.done.durationMs)}` : 'Done', tone: 'success' as const }
    : model.status;
  return (
    <div
      data-testid="home-mission-row"
      data-status={model.status.label.toLowerCase().replace(/\s+/g, '_')}
      className="grid grid-cols-1 items-center gap-x-6 gap-y-2 border-b border-border-default px-4 py-3.5 last:border-b-0 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)_auto] md:px-6"
    >
      <div className="min-w-0">
        <StatusWord {...status} />
        <Link href={view.href} className="mt-1 block truncate font-mono text-[14px] font-semibold text-text-primary hover:underline md:text-[15px]">
          {view.title}
        </Link>
      </div>
      {r ? (
        <div className="flex min-w-0 items-center gap-3 font-mono text-[12px] text-text-secondary">
          <span className="whitespace-nowrap border border-border-default px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.5px]">↻ {r.cadence}</span>
          <span className="flex gap-1" aria-hidden="true">
            {r.runs.map(run => <i key={run.taskId} className={`inline-block h-3 w-3 border ${RUN_PIP[run.state]}`} />)}
          </span>
          {r.lastSummary && <span className="hidden truncate text-text-muted md:inline">last: {r.lastSummary}</span>}
        </div>
      ) : (
        <div className="min-w-0"><PhaseBar phases={model.phases} size="sm" /></div>
      )}
      <div className="flex items-center justify-start gap-3 whitespace-nowrap font-mono text-[12px] text-text-secondary md:justify-end">
        {r ? (
          nextLabel(r.nextMins) && <span>{r.nextMins! > 0 && 'next '}<b className="text-text-primary">{nextLabel(r.nextMins)}</b></span>
        ) : (
          <>
            {model.live.count > 0 && (
              <span className="flex gap-[3px]" aria-label={`${model.live.count} live`}>
                {model.live.dots.slice(0, 8).map((d, i) => (
                  <i key={i} className={`inline-block h-2.5 w-2.5 ${d.color ? '' : 'bg-accent'}`} style={d.color ? { backgroundColor: d.color } : undefined} />
                ))}
              </span>
            )}
            {model.kind === 'done' && model.criteria && (
              <span className="border border-status-success px-1.5 py-0.5 text-[11px] font-semibold uppercase text-status-success">
                {model.criteria.passed}/{model.criteria.total} criteria
              </span>
            )}
            {model.counts.total > 0 && <span><b className="text-text-primary">{model.counts.done}</b>/{model.counts.total}</span>}
            {model.elapsedMin != null && <span className="text-text-muted">{model.elapsedMin}m</span>}
          </>
        )}
      </div>
    </div>
  );
}

export function HomeMissionsSummary({ rows, total, shippedToday }: { rows: readonly HomeMissionRow[]; total: number; shippedToday: number }) {
  return (
    <section data-testid="home-missions" className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="section-label text-text-muted">Missions</span>
        <Link href="/app/missions" className="inline-flex min-h-11 items-center font-mono text-[12px] text-text-muted hover:text-text-secondary md:min-h-0">
          {shippedToday > 0 ? `${shippedToday} shipped · ` : ''}{total} total →
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="border border-dashed border-border-strong px-5 py-4 font-mono text-[12.5px] text-text-secondary">
          No missions running. <Link href="/app/missions/new" className="text-accent-text hover:underline">Start one</Link>.
        </div>
      ) : (
        <div className="card p-0">
          {rows.map(r => <Row key={r.view.id} {...r} />)}
        </div>
      )}
    </section>
  );
}
