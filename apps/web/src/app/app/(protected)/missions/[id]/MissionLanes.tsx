'use client';

/**
 * The mission Lanes tab: runner slots as rows, tasks as bars on a time axis
 * (`SlotLanes`), a NOW line with the future hatched, the merged-PR track, and
 * a side rail for what needs attention — Needs you / In review / Up next, or
 * the completion record once the mission is done. Hovering a bar shows its
 * milestones and draws edges from what it waited on.
 */
import { useMemo, useState } from 'react';
import SlotLanes, { type SlotLane, type SlotLaneBar } from '@/components/fleet/SlotLanes';
import { fitLaneWindowStart, formatAxisMinutes, LANE_WINDOW_MIN_SPAN_MS } from '@/components/fleet/slot-lanes-layout';
import { formatAge, formatClock, type BoardTask, type MissionBoardModel, type MissionLaneBar } from '@/lib/mission-board';
import {
  AnswerButtons, CriterionBox, LandedMeter, RunnerAvatar, ScopeChip, SectionLabel,
  taskSheetHref, useLiveBoard, useNow, type BoardLinkContext,
} from './MissionBoardParts';
import { MISSION_CRITERIA_ANCHOR } from '@/components/missions/MissionSituationBlock';

export interface MissionLanesProps extends BoardLinkContext {
  model: MissionBoardModel;
  completionText?: string | null;
}

/** Look-ahead past NOW while running. */
const LOOKAHEAD_MS = 5 * 60_000;

/**
 * The axis: from just before the mission's first run (the mission start when
 * that is sooner), to NOW plus a look-ahead, at least `LANE_WINDOW_MIN_SPAN_MS`
 * wide; a finished run is fitted with a little air.
 */
export function laneWindow(model: Pick<MissionBoardModel, 'startedAt' | 'complete' | 'bars' | 'merges'>, now: number): { from: number; to: number } {
  const earliest = model.bars.length ? Math.min(...model.bars.map(b => b.start)) : model.startedAt;
  const from = fitLaneWindowStart({ earliest, now, minSpanMs: 0, anchor: model.startedAt });
  if (model.complete) {
    const last = Math.max(from + 60_000, ...model.bars.map(b => b.end ?? now), ...model.merges.map(m => m.at));
    return { from, to: from + (last - from) * 1.03 };
  }
  return { from, to: Math.max(from + LANE_WINDOW_MIN_SPAN_MS, now + LOOKAHEAD_MS) };
}

export default function MissionLanes({ model: serverModel, completionText, ...link }: MissionLanesProps) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  const { from, to } = laneWindow(model, now);

  const lanes: SlotLane[] = useMemo(() => {
    const byRunner = new Map<string, MissionLaneBar[]>();
    for (const b of model.bars) byRunner.set(b.runnerId, [...(byRunner.get(b.runnerId) ?? []), b]);
    return model.runners.map(r => ({
      id: r.id,
      label: r.name,
      badge: r.initial,
      minSlots: r.capacity,
      bars: (byRunner.get(r.id) ?? []).map((b): SlotLaneBar => ({
        id: b.id,
        start: b.start,
        end: b.end,
        tone: b.tone,
        scope: b.scope,
        label: b.label,
        prefix: b.retry ? '↻' : null,
        endMark: b.endMark,
        waits: b.waits,
        group: b.taskId,
        deps: b.deps,
        href: taskSheetHref(link, b.taskId),
        linkData: { 'data-task-id': b.taskId },
        title: model.tasks[b.taskId]?.title,
      })),
    }));
  }, [model, link]);

  const phases = useMemo(() => model.phases.flatMap(p => {
    const bars = model.bars.filter(b => p.taskIds.includes(b.taskId) && !b.retry);
    if (bars.length === 0 || !p.label) return [];
    const start = Math.min(...bars.map(b => b.start));
    const endOf = (id: string) => {
      const t = model.tasks[id];
      const m = model.merges.find(x => x.taskId === id)?.at;
      return m ?? t.endedAt ?? now;
    };
    const end = Math.min(now, Math.max(...p.taskIds.map(endOf)));
    return [{ id: p.key, label: `${p.ordinal} ${p.label}`, start, end: Math.max(end, start) }];
  }), [model, now]);

  const marks = useMemo(() => [
    ...model.merges.map(m => ({ id: `m${m.pr}`, at: m.at, label: String(m.pr), tone: 'ok' as const })),
    ...model.ciFails.map((f, i) => ({ id: `f${i}`, at: f.at, label: 'CI', tone: 'fail' as const })),
  ], [model]);

  // The detail panel follows the hovered bar; at rest it shows what most
  // likely matters — the waiting task, else the newest live bar.
  const defaultBar = useMemo(() => {
    const waiting = model.bars.find(b => b.tone === 'waiting');
    const live = model.bars.filter(b => b.end == null).sort((a, b) => b.start - a.start)[0];
    const last = model.bars.filter(b => b.tone !== 'plan').sort((a, b) => (b.end ?? now) - (a.end ?? now))[0];
    return waiting ?? live ?? last ?? null;
  }, [model, now]);
  const [hovered, setHovered] = useState<SlotLaneBar | null>(null);
  const detailBar = hovered ? model.bars.find(b => b.id === hovered.id) ?? null : defaultBar;

  return (
    <div data-testid="mission-lanes" className="flex flex-col">
      <Strip model={model} />
      <div className="mt-1.5 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div className="mt-[22px] overflow-x-auto pt-6">
            <div className="min-w-[720px]">
              <SlotLanes
                testId="mission-lanes-chart"
                lanes={lanes}
                from={from}
                to={to}
                now={model.complete ? null : now}
                nowLabel={`NOW ${formatClock(now - model.startedAt)}`}
                tickLabel={at => formatAxisMinutes(Math.round((at - model.startedAt) / 60_000))}
                phases={phases}
                marks={marks}
                marksLabel={`Merged ${model.merges.length}`}
                onHover={setHovered}
                pinnedId={hovered ? null : defaultBar?.id ?? null}
              />
            </div>
          </div>
          {detailBar && <Detail bar={detailBar} model={model} now={now} />}
        </div>
        <Side model={model} now={now} link={link} completionText={completionText ?? null} />
      </div>
      <Legend />
    </div>
  );
}

function Strip({ model }: { model: MissionBoardModel }) {
  const cell = 'flex items-center gap-3 py-3 pr-[22px] mr-[22px] border-border-default';
  return (
    <section data-testid="mission-strip" className="mt-4 flex flex-wrap items-stretch border-b border-t-2 border-b-border-default border-t-border-strong">
      <div data-testid="landed-band" className={`${cell} md:border-r`}>
        <SectionLabel>Landed</SectionLabel>
        <span className="font-mono text-[26px] font-semibold leading-none tracking-[-0.6px] tabular-nums text-text-primary">
          {model.landed.done}<small className="ml-1 text-[12px] font-medium tracking-normal text-text-muted">{`/${model.landed.total}`}</small>
        </span>
        <LandedMeter model={model} variant="strip" />
      </div>
      <a href={`#${MISSION_CRITERIA_ANCHOR}`} data-testid="goal-band" className={`${cell} min-w-0 flex-wrap md:border-r hover:bg-card-hover`}>
        <SectionLabel>Goal</SectionLabel>
        <span className="flex flex-wrap gap-3">
          {model.criteria.map((c, i) => (
            <span key={i} data-testid="goal-criterion" data-state={c.state} className="flex items-center gap-1.5 font-mono text-[12px] md:text-[11.5px] text-text-secondary">
              <CriterionBox c={c} size={13} />
              {c.label}
              {i === 0 && c.label === 'PRs merged' && <b className="font-semibold tabular-nums text-text-primary">{c.value}</b>}
            </span>
          ))}
        </span>
      </a>
      <div data-testid="fleet-band" className={cell}>
        <SectionLabel>Live</SectionLabel>
        <span className="font-mono text-[26px] font-semibold leading-none tracking-[-0.6px] tabular-nums text-text-primary">
          {model.live}<small className="ml-1 text-[12px] font-medium tracking-normal text-text-muted">{`/${model.capacity} slots`}</small>
        </span>
      </div>
    </section>
  );
}

function Detail({ bar, model, now }: { bar: MissionLaneBar; model: MissionBoardModel; now: number }) {
  const t: BoardTask | undefined = model.tasks[bar.taskId];
  const span = Math.max(1, (bar.end ?? now) - bar.start);
  const own = t && t.workerId === bar.id ? t.milestones : [];
  const last = own[own.length - 1];
  const slotIndex = t && t.workerId === bar.id && t.slot != null ? t.slot + 1 : null;
  return (
    <section data-testid="mission-lanes-detail" className="mt-[18px] flex flex-col gap-3 border-[1.5px] border-border-strong bg-surface-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 font-mono text-[13px]">
        {t?.glyph && <span className="text-text-muted" style={t.roleColor ? { color: t.roleColor } : undefined}>{t.glyph}</span>}
        <ScopeChip scope={bar.scope} />
        <b className="shrink-0 font-semibold text-text-primary">{bar.label}</b>
        {t && <span className="ml-2 min-w-0 truncate text-[12px] md:text-[11.5px] text-text-muted">{t.title}</span>}
      </div>
      <div className="flex flex-wrap items-start gap-7">
        <Kv k="runner" v={`${bar.runner}${slotIndex ? ` ·${slotIndex}` : ''}`} />
        <Kv k={bar.end == null ? 'running' : 'ran'} v={formatAge(span)} />
        <Kv k="after" v={t && t.deps.length ? t.deps.map(d => `${d.scope ?? d.label}${d.ok ? ' ✓' : ''}`).join('  ') : '—'} />
        <Kv k="unblocks" v={t && t.unblocks.length ? t.unblocks.map(u => u.scope ?? u.label).join('  ') : '—'} />
        <div className="flex min-w-[200px] flex-1 flex-col gap-[5px]">
          <SectionLabel>{`${own.length} milestone${own.length === 1 ? '' : 's'}`}</SectionLabel>
          <div className="relative mt-0.5 h-2.5 border-b-[1.5px] border-[var(--fleet-border-mid)]">
            {own.map((m, i) => (
              <span
                key={i}
                title={m.label}
                className={`absolute -bottom-[5px] block h-[9px] w-[9px] -translate-x-1/2 ${i === own.length - 1 && bar.end == null ? 'bg-accent' : 'bg-text-secondary'}`}
                style={{ left: `${Math.min(1, Math.max(0, (m.ts - bar.start) / span)) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-1.5 truncate font-mono text-[12px] md:text-[11.5px] text-text-secondary">{last ? last.label : '—'}</div>
        </div>
      </div>
    </section>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <SectionLabel>{k}</SectionLabel>
      <b className="font-mono text-[12.5px] font-semibold text-text-primary">{v}</b>
    </div>
  );
}

function Side({ model, now, link, completionText }: { model: MissionBoardModel; now: number; link: BoardLinkContext; completionText: string | null }) {
  const sec = (label: string, n: number, hot: boolean, testId: string, body: React.ReactNode) => (
    <div data-testid={testId}>
      <div className={`mb-1.5 flex items-center gap-2 border-b-2 border-border-strong pb-[7px] font-mono text-[11px] md:text-[10.5px] font-semibold uppercase tracking-[1.6px] ${hot ? 'text-accent-text' : 'text-text-muted'}`}>
        {label}
        <b className="ml-auto text-text-primary">{n}</b>
      </div>
      {body}
    </div>
  );
  const row = 'flex h-[34px] min-w-0 items-center gap-[7px] border-b border-border-default font-mono text-[12px] text-text-secondary hover:bg-card-hover';

  if (model.complete) {
    const r = model.record;
    const stat = (n: string, l: string, cls = 'text-text-primary') => (
      <div className="flex flex-col gap-[3px]">
        <b className={`font-mono text-[22px] font-semibold tabular-nums ${cls}`}>{n}</b>
        <span className="font-mono text-[11px] md:text-[10px] uppercase tracking-[1.2px] text-text-muted">{l}</span>
      </div>
    );
    return (
      <aside className="mt-[22px] flex min-w-0 flex-col gap-[18px]">
        <div data-testid="mission-completion-record" className="flex flex-col gap-3 border-2 border-border-strong bg-card p-3.5 shadow-[3px_3px_0_0_var(--border-strong)]">
          <SectionLabel className="!text-status-success">Completion record</SectionLabel>
          {completionText && <p className="font-mono text-[12px] leading-[1.55] text-text-secondary whitespace-pre-line">{completionText}</p>}
          <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
            {stat(String(r.prsMerged), 'PRs merged')}
            {stat(String(r.peakAgents), 'peak agents')}
            {stat(`+${r.linesAdded.toLocaleString()}`, 'lines')}
            {stat(String(r.runners), 'runners')}
            {stat(String(r.ciFixes), 'CI auto-fixed', r.ciFixes ? 'text-status-error' : 'text-text-primary')}
            {stat(String(r.decisions), 'your answers', r.decisions ? 'text-accent-text' : 'text-text-primary')}
          </div>
        </div>
        {sec('Goal criteria', model.criteriaPassed, false, 'lanes-criteria', model.criteria.map((c, i) => (
          <div key={i} className={row}>
            <CriterionBox c={c} size={13} />
            <span className="min-w-0 truncate font-medium text-text-primary">{c.label}</span>
            <span className="flex-1" />
            <span className="tabular-nums">{c.value}</span>
          </div>
        )))}
      </aside>
    );
  }

  const ny = model.needsYou.map(id => model.tasks[id]);
  const review = model.inReview.map(id => model.tasks[id]);
  const next = model.upNext.map(id => model.tasks[id]);
  return (
    <aside className="mt-[22px] flex min-w-0 flex-col gap-[18px]">
      {sec('Needs you', ny.length, ny.length > 0, 'needs-you-band', ny.length === 0
        ? <div className="py-2 font-mono text-[12px] md:text-[11.5px] text-[var(--fleet-faint)]">Nothing waiting on you.</div>
        : ny.map(t => (
          <div key={t.id} className="flex flex-col gap-2.5 border-2 border-accent bg-card p-3 shadow-[3px_3px_0_0_var(--border-strong)]">
            <div className="flex items-center gap-[7px] font-mono text-[12px] text-text-muted">
              <RunnerAvatar runner={t.runner} />
              <ScopeChip scope={t.scope} />
              <span>{`${formatAge(t.waitStartedAt != null ? now - t.waitStartedAt : 0)} ago`}</span>
            </div>
            <p className="font-mono text-[13px] font-semibold leading-[1.45] text-text-primary [overflow-wrap:anywhere]">{t.waitingFor?.prompt ?? 'Waiting on you.'}</p>
            <AnswerButtons workerId={t.workerId} options={t.waitingFor?.options ?? []} compact />
          </div>
        )))}
      {sec('In review', review.length, false, 'lanes-in-review', review.length === 0
        ? <div className="py-2 font-mono text-[12px] md:text-[11.5px] text-[var(--fleet-faint)]">No open PRs.</div>
        : review.map(t => {
          const fail = t.status === 'ci_failed' || t.status === 'fixing';
          const green = t.pr?.state === 'open';
          return (
            <a key={t.id} href={taskSheetHref(link, t.id)} data-task-id={t.id} className={row}>
              <ScopeChip scope={t.scope} />
              <span className="min-w-0 truncate font-medium text-text-primary">{t.label}</span>
              <span className="flex-1" />
              {t.pr && (
                <span className={`shrink-0 text-[11px] font-semibold ${fail ? 'text-status-error' : green ? 'text-status-success' : 'text-accent-text'}`}>
                  {`#${t.pr.number} ${fail ? (t.status === 'fixing' ? '↻ fix' : '✕') : green ? '● green' : '◌ CI'}`}
                </span>
              )}
            </a>
          );
        }))}
      {sec('Up next', next.length, false, 'lanes-up-next', next.length === 0
        ? <div className="py-2 font-mono text-[12px] md:text-[11.5px] text-[var(--fleet-faint)]">Queue empty.</div>
        : next.map(t => (
          <a key={t.id} href={taskSheetHref(link, t.id)} data-task-id={t.id} className={row}>
            <ScopeChip scope={t.scope} />
            <span className="min-w-0 truncate font-medium text-text-primary">{t.label}</span>
            <span className="flex-1" />
            <span className="flex shrink-0 gap-[3px]">
              {t.status === 'ready'
                ? <span className="text-text-muted">ready</span>
                : t.deps.map(d => <ScopeChip key={d.id} scope={d.scope ?? d.label} tone={d.ok ? 'ok' : 'ghost'} className="!h-4 !px-1" />)}
            </span>
          </a>
        )))}
    </aside>
  );
}

function Legend() {
  const sw = 'mr-1.5 inline-block h-2.5 w-3.5 align-[-1px] border-[1.5px]';
  return (
    <footer className="mt-6 hidden flex-wrap items-center gap-4 border-t border-border-default py-2.5 font-mono text-[11px] text-text-muted md:flex">
      <span><i className={`${sw} border-accent bg-accent-soft`} />working</span>
      <span><i className={`${sw} border-border-strong bg-surface-3`} />done</span>
      <span><i className={`${sw} fleet-hatch-accent h-1.5 border border-accent`} />waiting on you</span>
      <span className="text-status-success">✓ merged</span>
      <span className="text-accent-text">◌ in CI</span>
      <span className="text-status-error">✕ CI failed</span>
      <span><i className={`${sw} border-dashed border-border-strong`} />planning</span>
      <span className="ml-auto">hover a bar for its milestones · click to open</span>
    </footer>
  );
}
