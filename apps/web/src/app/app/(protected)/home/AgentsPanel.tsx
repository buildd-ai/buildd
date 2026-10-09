/**
 * Home's Agents panel: "3 of 4 busy", one square per slot (the squares are
 * only ever now), the same number's 24h water level with idle-while-queued
 * shaded, and one line per busy slot naming the work. Steer and Stop live on
 * the task, not here; the per-slot lanes live on Health › Runners.
 * Model: lib/home-agents.ts. Server-safe (no hooks).
 */
import Link from 'next/link';
import { OccupancySparkline } from '@/components/fleet/OccupancySparkline';
import type { OccupancySeries } from '@/lib/fleet-occupancy';
import { agentsSummary, elapsedLabel, type AgentSquare, type AgentsModel } from '@/lib/home-agents';
import { idleStretchLabel, type IdleStretch } from '@/lib/idle-while-queued';

const RUNNERS_HREF = '/app/health/runners';

function Square({ kind }: { kind: AgentSquare }) {
  if (kind === 'busy') return <i aria-hidden="true" data-testid="agent-square" data-kind="busy" className="block h-4 w-4 rounded-sm bg-accent" />;
  if (kind === 'waiting') return <i aria-hidden="true" data-testid="agent-square" data-kind="waiting" data-state="waiting" data-tone="act" data-pattern="hatch-bold" className="state-cell block h-4 w-4 rounded-sm shadow-[inset_0_0_0_1px_var(--accent)]" />;
  return <i aria-hidden="true" data-testid="agent-square" data-kind="free" className="block h-4 w-4 rounded-sm shadow-[inset_0_0_0_1px_var(--border-strong)]" />;
}

export function AgentsPanel({ model, occupancy, idle = [], idPrefix = 'home' }: { model: AgentsModel; occupancy?: OccupancySeries | null; idle?: readonly IdleStretch[]; idPrefix?: string }) {
  const longest = [...idle].sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  const waiting = model.squares.filter(s => s === 'waiting').length;
  return (
    <section data-testid="home-agents" aria-labelledby={`${idPrefix}-agents-h`} style={{ gridArea: 'agents' }} className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={`${idPrefix}-agents-h`} className="section-label">Agents</h2>
        <span data-testid="agents-summary" className="font-mono text-meta text-text-muted">{model.total > 0 ? agentsSummary(model) : 'no runner online'}</span>
      </div>
      {model.total > 0 && (
        <div role="img" aria-label={`${agentsSummary(model)}${waiting > 0 ? `, ${waiting} waiting for input` : ''}`} className="flex flex-wrap gap-1">
          {model.squares.map((s, i) => <Square key={i} kind={s} />)}
        </div>
      )}
      {occupancy && <OccupancySparkline series={occupancy} shade={idle} />}
      {longest && (
        <Link data-testid="agents-idle" href={RUNNERS_HREF} className="mt-1 inline-flex min-h-11 items-center font-mono text-meta text-text-secondary hover:text-text-primary md:min-h-0">
          {idleStretchLabel(longest)} ›
        </Link>
      )}
      {model.lines.length > 0 && (
        <ul className="mt-3 divide-y divide-border-default border-t border-border-default">
          {model.lines.map(l => {
            const body = (
              <>
                <span aria-hidden="true" className={`shrink-0 ${l.waiting ? 'text-status-warning' : 'text-accent-text'}`}>{l.waiting ? '◇' : '▶'}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-text-primary">{l.name}{l.rest ? ` ${l.rest}` : ''}</span>
                  {l.mission && <span className="block truncate font-mono text-meta text-text-muted">{l.mission}</span>}
                </span>
                <span className="shrink-0 font-mono text-meta tabular-nums text-text-muted">{l.waiting ? 'needs you · ' : ''}{l.elapsedMs != null ? elapsedLabel(l.elapsedMs) : ''}</span>
              </>
            );
            return (
              <li key={l.key} data-testid="agent-line" data-waiting={l.waiting ? 'true' : undefined}>
                {l.href
                  ? <Link href={l.href} className="flex min-h-11 items-center gap-2.5 py-1.5 hover:underline md:min-h-0">{body}</Link>
                  : <div className="flex items-center gap-2.5 py-1.5">{body}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {model.total > 0 && model.lines.length === 0 && <p className="mt-3 font-mono text-meta text-text-muted">Every slot is free.</p>}
    </section>
  );
}
