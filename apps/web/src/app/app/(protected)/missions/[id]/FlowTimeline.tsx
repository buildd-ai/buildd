'use client';

/**
 * The mission Flow tab: one row per task in dependency order, each a bar on
 * one time axis (solid = done or so far, hatched = still to come, a thin line
 * out to p80 when there is one), a now line, an outline on the critical path,
 * and every gate as a faint elbow from the blocker's bar end to the
 * dependent's bar start. Selecting a row lights its edges the way the strip
 * marks it. Above it, one sentence: what sets the finish.
 *
 * Spec: docs/specs/mission-flow-timeline.md. The model is
 * `lib/flow-timeline.ts`; this file only draws it, in percentages and rows.
 */
import { useMemo, useState } from 'react';
import FocusCard from '@/components/ui/FocusCard';
import { STATES } from '@/components/ui/states';
import type { MissionBoardModel } from '@/lib/mission-board';
import {
  buildFlowTimeline, criticalPathLine, defaultFlowSelection, flowAxisTicks, flowEdgePaths, flowEdges, flowLit,
  FLOW_ROW_UNITS, FLOW_X_UNITS, layoutFlowTimeline, type FlowBarLayout, type FlowTimeline as FlowTimelineModel,
} from '@/lib/flow-timeline';
import { stripSelectionReason, type StripState } from '@/lib/mission-task-strip';
import { taskSheetHref, useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';

export interface FlowTimelineProps extends BoardLinkContext {
  model: MissionBoardModel;
  /** Dependent id → the tasks Buildd made it wait on because both change the same files. */
  sameFiles?: Readonly<Record<string, readonly string[]>>;
  /** Task id → expected minutes (the task's expected size). */
  expectedMinutes?: Readonly<Record<string, number | null | undefined>>;
  /** Open on this task instead of the one setting the finish. */
  initialSelected?: string | null;
  /** One column at every width (a narrow host such as chat's pane). */
  compact?: boolean;
}

const word = (s: StripState) => STATES[s].word;

/** Label column + gap, in px: the overlay (edges, now line) sits over the track only. */
const LABEL_COLS = 'grid-cols-[86px_minmax(0,1fr)] md:grid-cols-[132px_minmax(0,1fr)]';
const TRACK_INSET = 'left-[96px] md:left-[142px]';
/** Every row is the same height, so the edge overlay can address rows by index. */
const ROW_H = 'h-11 md:h-[30px]';

export default function FlowTimeline({ model: serverModel, sameFiles, expectedMinutes, initialSelected, compact = false, ...link }: FlowTimelineProps) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 30_000, !model.complete);
  const timeline = useMemo(() => buildFlowTimeline({ model, now, sameFiles, expectedMinutes }), [model, now, sameFiles, expectedMinutes]);
  const [picked, setPicked] = useState<string | null>(initialSelected ?? null);
  const [mergedOpen, setMergedOpen] = useState(false);
  const selected = picked && timeline.tasks[picked] ? picked : defaultFlowSelection(timeline);

  const layout = useMemo(() => layoutFlowTimeline(timeline, { mergedOpen }), [timeline, mergedOpen]);
  const lit = useMemo(() => flowLit(model, selected), [model, selected]);
  const paths = useMemo(() => flowEdgePaths(timeline, layout, flowEdges(timeline, lit)), [timeline, layout, lit]);
  const ticks = useMemo(() => flowAxisTicks(timeline).filter(t => Math.abs(t.at - layout.nowAt) > 6), [timeline, layout.nowAt]);
  const line = criticalPathLine(timeline, word);
  const hasP80 = timeline.order.some(id => timeline.tasks[id].p80End != null);

  if (timeline.order.length === 0) {
    return <p data-testid="flow-timeline-empty" className="pt-6 text-body text-text-muted">No tasks yet.</p>;
  }

  const inFlight = timeline.order.filter(id => timeline.tasks[id].kind === 'run' && timeline.tasks[id].state !== 'failed');
  const notStarted = timeline.order.filter(id => timeline.tasks[id].kind === 'plan');

  return (
    <div data-testid="flow-timeline" className={`grid gap-7 pt-5 ${compact ? '' : 'md:grid-cols-[minmax(0,720px)_minmax(260px,1fr)] md:items-start md:gap-12'}`}>
      <div className="flex min-w-0 flex-col gap-3.5">
        {line && <CriticalPathLine line={line} />}

        <div className="flex flex-col">
          <div aria-hidden="true" className={`grid ${LABEL_COLS} gap-2.5`}>
            <span />
            <div data-testid="flow-axis" className="relative h-4 font-mono text-chip text-text-muted">
              {ticks.map(t => (
                <span key={t.label} className={`absolute ${t.at === 0 ? '' : '-translate-x-1/2'}`} style={{ left: `${t.at}%` }}>{t.label}</span>
              ))}
              {!model.complete && <span className="absolute -translate-x-1/2 text-accent-text" style={{ left: `${layout.nowAt}%` }}>now</span>}
            </div>
          </div>

          <div className="relative">
            <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-0 ${TRACK_INSET}`}>
              <svg
                data-testid="flow-edges"
                className="absolute inset-0 h-full w-full overflow-visible"
                viewBox={`0 0 ${FLOW_X_UNITS} ${layout.rows.length * FLOW_ROW_UNITS}`}
                preserveAspectRatio="none"
              >
                {paths.map(p => (
                  <path
                    key={`${p.from}>${p.to}`}
                    d={p.d}
                    data-from={timeline.tasks[p.from].tick}
                    data-to={timeline.tasks[p.to].tick}
                    data-on={p.on || undefined}
                    data-kind={p.kind}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray={p.kind === 'same_files' ? '1 3' : undefined}
                    style={{
                      stroke: p.on ? (p.critical ? 'var(--text-primary)' : 'var(--accent)') : 'var(--border-strong)',
                      strokeWidth: p.on ? 1.75 : 1,
                      opacity: p.on ? 1 : 0.55,
                    }}
                  />
                ))}
              </svg>
              {!model.complete && <span data-testid="flow-now" className="absolute -inset-y-1 w-px bg-accent" style={{ left: `${layout.nowAt}%` }} />}
            </div>

            <ol className="relative flex flex-col" aria-label="Tasks over time">
              {layout.rows.map(row => {
                if (row.kind === 'merged') {
                  return (
                    <li key="merged">
                      <button
                        type="button"
                        data-testid="flow-merged-row"
                        aria-expanded={false}
                        onClick={() => setMergedOpen(true)}
                        className={`grid w-full ${LABEL_COLS} ${ROW_H} items-center gap-2.5 text-left`}
                      >
                        <span className="truncate text-body text-text-muted"><span aria-hidden="true" className="mr-1.5 font-mono text-chip">■</span>{row.ids.length} merged ›</span>
                        <span className="relative h-[18px]">{row.bars.map(b => <Bar key={b.id} bar={b} state="landed" />)}</span>
                      </button>
                    </li>
                  );
                }
                const t = model.tasks[row.id];
                const ft = timeline.tasks[row.id];
                const on = row.id === selected;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid="flow-row"
                      data-task-row={row.id}
                      data-tick={ft.tick}
                      aria-pressed={on}
                      aria-label={`${ft.tick} ${t.scope ?? t.label}: ${word(ft.state)}`}
                      onClick={() => setPicked(row.id)}
                      className={`grid w-full ${LABEL_COLS} ${ROW_H} items-center gap-2.5 text-left`}
                    >
                      <span className={`truncate text-body ${on ? 'font-semibold text-text-primary' : ft.kind === 'done' ? 'text-text-muted' : 'text-text-primary'}`}>
                        <span className="mr-1.5 font-mono text-chip text-text-muted">{ft.tick}</span>
                        {t.scope ?? t.label}
                      </span>
                      <span className="relative h-[18px]"><Bar bar={row.bar} state={ft.state} /></span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>

          {layout.foldable && !layout.folded && (
            <button type="button" data-testid="flow-fold-merged" onClick={() => setMergedOpen(false)} className="mt-1.5 min-h-11 self-start text-meta text-text-muted hover:text-text-primary md:min-h-0">
              Fold merged
            </button>
          )}
        </div>

        <p className="font-mono text-chip text-text-muted">
          solid = done or so far · hatched = still to come{hasP80 ? ' · thin line = if it runs long' : ''} · outline = sets the finish · select a task to light up what it waits on and unblocks
        </p>

        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-t border-border-default pt-4 text-body">
          <dt className="text-text-muted">In parallel</dt>
          <dd>{inFlight.length ? inFlight.map(id => timeline.tasks[id].tick).join(', ') : 'nothing'}</dd>
          {notStarted.length > 0 && (
            <>
              <dt className="text-text-muted">Not started</dt>
              <dd>{notStarted.map(id => `${timeline.tasks[id].tick} ${word(timeline.tasks[id].state).toLowerCase()}`).join(', ')}</dd>
            </>
          )}
        </dl>
      </div>

      {selected && (
        <aside className={compact ? '' : 'md:sticky md:top-4'}>
          <SelectedTask model={model} timeline={timeline} id={selected} link={link} />
        </aside>
      )}
    </div>
  );
}

function CriticalPathLine({ line }: { line: string }) {
  const cut = line.indexOf(' (');
  return (
    <p data-testid="flow-critical-path" className="text-title">
      <b className="font-semibold text-text-primary">{line.slice(0, cut)}</b>
      <span className="text-text-secondary">{line.slice(cut)}</span>
    </p>
  );
}

/** Solid segment (state tone), then what is still to come (hatched), then the p80 line. */
function Bar({ bar, state }: { bar: FlowBarLayout; state: StripState }) {
  const s = STATES[state];
  const outline = bar.critical ? 'outline outline-[1.5px] outline-text-primary' : '';
  const solid = bar.kind === 'done'
    ? <span data-segment="solid" className="state-cell absolute inset-y-[3px] min-w-[2px] rounded-[2px]" data-tone="ok" data-pattern="solid" style={{ left: `${bar.left}%`, width: `${bar.solid}%` }} />
    : bar.solid > 0
      ? <span data-segment="solid" className="state-cell absolute inset-y-[3px] min-w-[2px] rounded-l-[2px] opacity-85" data-tone={s.tone} style={{ left: `${bar.left}%`, width: `${bar.solid}%`, background: 'var(--cell-ink)' }} />
      : null;
  const forecast = bar.forecast > 0
    ? <span data-segment="forecast" className="state-cell absolute inset-y-[3px] min-w-[2px] rounded-r-[2px]" data-tone="q" data-pattern={state === 'blocked' ? 'hatch-dense' : 'hatch-sparse'} style={{ left: `${bar.left + bar.solid}%`, width: `${bar.forecast}%` }} />
    : null;
  return (
    <span data-bar={bar.id} data-kind={bar.kind} data-critical={bar.critical || undefined} className="contents">
      {bar.p80 != null && <span data-segment="p80" className="absolute top-2 h-0.5 bg-border-strong" style={{ left: `${bar.left}%`, width: `${bar.p80}%` }} />}
      {solid}
      {forecast}
      {bar.critical && <span className={`pointer-events-none absolute inset-y-[3px] rounded-[2px] ${outline}`} style={{ left: `${bar.left}%`, width: `${bar.solid + bar.forecast}%` }} />}
    </span>
  );
}

function reasonOf(text: string | null): { lead: string; text: string } | null {
  if (!text) return null;
  const m = /^(After|Unblocks) (.*)$/.exec(text);
  return m ? { lead: m[1], text: m[2] } : null;
}

function SelectedTask({ model, timeline, id, link }: { model: MissionBoardModel; timeline: FlowTimelineModel; id: string; link: BoardLinkContext }) {
  const t = model.tasks[id];
  const ft = timeline.tasks[id];
  const tickOf = (x: string) => timeline.tasks[x]?.tick ?? '··';
  const reason = reasonOf(stripSelectionReason(model, id, tickOf));
  const meta = [ft.tick, `level ${t.level} of ${t.levels}`, t.roleName].filter(Boolean).join(' · ');
  return (
    <FocusCard
      meta={meta}
      title={t.title}
      state={ft.state}
      next={t.currentAction ?? undefined}
      reason={reason}
      footer={
        <a href={taskSheetHref(link, id)} data-task-id={id} className="inline-flex min-h-11 items-center self-start text-meta text-text-secondary hover:text-text-primary md:min-h-0">
          Open task ›
        </a>
      }
    />
  );
}
