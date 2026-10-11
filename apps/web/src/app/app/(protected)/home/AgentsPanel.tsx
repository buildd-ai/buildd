/**
 * Home's Agents panel: "3 of 4 busy" beside one square per slot (the squares
 * are only ever now), the same number's 24h water level with idle-while-queued
 * shaded, and one line per busy slot naming the work. Each line wears its
 * slot's square, so the squares, the line and the list share one meaning.
 * Steer and Stop live on the task, not here; the per-slot lanes live on
 * Health › Runners. Model: lib/home-agents.ts. Server-safe (no hooks).
 */
import Link from 'next/link';
import { OccupancySparkline } from '@/components/fleet/OccupancySparkline';
import type { OccupancySeries } from '@/lib/fleet-occupancy';
import { agentsSummary, elapsedLabel, type AgentSquare, type AgentsModel } from '@/lib/home-agents';
import { idleStretchLabel, type IdleStretch } from '@/lib/idle-while-queued';

const RUNNERS_HREF = '/app/health/runners';

function Square({ kind, size = 'h-3 w-3', testId = 'agent-square' }: { kind: AgentSquare; size?: string; testId?: string }) {
  if (kind === 'busy') return <i aria-hidden="true" data-testid={testId} data-kind="busy" className={`block shrink-0 rounded-[var(--radius-cell)] bg-accent ${size}`} />;
  if (kind === 'waiting') return <i aria-hidden="true" data-testid={testId} data-kind="waiting" data-state="waiting" data-tone="act" data-pattern="hatch-bold" className={`state-cell block shrink-0 rounded-[var(--radius-cell)] shadow-[inset_0_0_0_1px_var(--accent)] ${size}`} />;
  return <i aria-hidden="true" data-testid={testId} data-kind="free" className={`block shrink-0 rounded-[var(--radius-cell)] shadow-[inset_0_0_0_1px_var(--border-strong)] ${size}`} />;
}

export function AgentsPanel({ model, occupancy, idle = [], idPrefix = 'home' }: { model: AgentsModel; occupancy?: OccupancySeries | null; idle?: readonly IdleStretch[]; idPrefix?: string }) {
  const longest = [...idle].sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  const waiting = model.squares.filter(s => s === 'waiting').length;
  return (
    <section data-testid="home-agents" aria-labelledby={`${idPrefix}-agents-h`} style={{ gridArea: 'agents' }} className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={`${idPrefix}-agents-h`} className="section-label">Agents</h2>
        <Link href={RUNNERS_HREF} className="inline-flex min-h-11 items-center text-meta text-text-muted hover:text-text-primary md:min-h-0">Runners ›</Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span data-testid="agents-summary" className="text-body text-text-secondary">
          {model.total > 0
            ? <><b className="font-mono font-semibold text-text-primary">{model.busy}</b> of {model.total} busy</>
            : 'No runner online'}
        </span>
        {model.total > 0 && (
          <span role="img" aria-label={`${agentsSummary(model)}${waiting > 0 ? `, ${waiting} waiting for input` : ''}`} className="flex flex-wrap justify-end gap-[3px]">
            {model.squares.map((s, i) => <Square key={i} kind={s} />)}
          </span>
        )}
      </div>
      {occupancy && <OccupancySparkline series={occupancy} shade={idle} />}
      {longest && (
        // Plain text under the chart's own caption: Runners › above is the way in.
        <p data-testid="agents-idle" className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-text-muted">
          <i aria-hidden="true" className="block h-2 w-2 shrink-0 bg-[var(--q-tint)] shadow-[inset_0_0_0_1px_var(--border-default)]" />
          {idleStretchLabel(longest)}
        </p>
      )}
      {model.lines.length > 0 && (
        <ul className="mt-3 divide-y divide-border-default border-t border-border-default">
          {model.lines.map(l => {
            const body = (
              <>
                <Square kind={l.waiting ? 'waiting' : 'busy'} size="mt-[5px] h-2 w-2" testId="agent-line-square" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-text-primary">{l.name}{l.rest ? <span className="font-normal text-text-secondary"> {l.rest}</span> : null}</span>
                  {l.mission && <span className="block truncate text-meta text-text-muted">{l.mission}</span>}
                </span>
                <span className="shrink-0 font-mono text-meta tabular-nums text-text-muted">
                  {l.waiting && <span className="text-accent-text">needs you{l.elapsedMs != null ? ' · ' : ''}</span>}
                  {l.elapsedMs != null ? elapsedLabel(l.elapsedMs) : ''}
                </span>
              </>
            );
            return (
              <li key={l.key} data-testid="agent-line" data-waiting={l.waiting ? 'true' : undefined}>
                {l.href
                  ? <Link href={l.href} className="flex min-h-11 items-start gap-2.5 py-2 hover:underline md:min-h-0">{body}</Link>
                  : <div className="flex items-start gap-2.5 py-2">{body}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {model.total > 0 && model.lines.length === 0 && <p className="mt-3 text-meta text-text-muted">Every slot is free.</p>}
    </section>
  );
}
