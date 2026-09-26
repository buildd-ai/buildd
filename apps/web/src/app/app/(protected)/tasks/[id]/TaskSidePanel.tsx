import Link from 'next/link';
import type { ReactNode } from 'react';
import StatusBadge, { STATUS_LABELS } from '@/components/StatusBadge';

/** The page header's status: one square pill, loud only when it's on you. */
export function HeaderStatusPill({ status, merged }: { status: string; merged: boolean }) {
  const base = 'inline-flex items-center gap-2 px-2.5 min-h-8 font-mono text-[11px] font-semibold uppercase tracking-[1.2px] border whitespace-nowrap';
  const dot = (extra = '') => <span className={`w-[7px] h-[7px] bg-current ${extra}`} aria-hidden="true" />;
  if (merged) return <span className={`${base} text-status-success border-status-success bg-status-success/10`}>{dot()}Merged</span>;
  switch (status) {
    case 'running':
    case 'starting':
    case 'in_progress':
      return <span className={`${base} text-accent-text border-accent bg-accent-soft`}>{dot('animate-status-pulse')}{status === 'starting' ? 'Starting' : 'Running'}</span>;
    case 'fixing_ci':
      // The task's own row is done, but a CI-fix attempt is still working its PR.
      return <span className={`${base} text-accent-text border-accent bg-accent-soft`}>{dot('animate-status-pulse')}Fixing CI</span>;
    case 'waiting_on_you':
    case 'waiting_input':
      return <span className={`${base} text-[var(--on-accent)] border-accent bg-accent`}>{dot()}Waiting on you</span>;
    case 'completed':
      return <span className={`${base} text-status-success border-status-success bg-status-success/10`}>{dot()}Completed</span>;
    case 'failed':
      return <span className={`${base} text-status-error border-status-error bg-status-error/10`}>{dot()}{STATUS_LABELS.failed}</span>;
    default:
      return <StatusBadge status={status} />;
  }
}

export interface FactRow {
  key: string;
  label: string;
  value: ReactNode;
}

/** The right-hand fact sheet: label/value rows in one bordered card. */
export function FactSheet({ rows, testId = 'task-fact-sheet' }: { rows: FactRow[]; testId?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl data-testid={testId} className="bg-card border-2 border-border-strong px-5 py-1">
      {rows.map(r => (
        <div key={r.key} data-testid={`task-fact-${r.key}`} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 py-3.5 border-b border-border-default last:border-b-0">
          <dt className="font-mono text-[11px] uppercase tracking-[2px] text-text-muted pt-0.5">{r.label}</dt>
          <dd className="min-w-0 font-mono text-[13px] text-text-primary [overflow-wrap:anywhere]">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface PeerTask {
  taskId: string;
  /** Scope chip ("checkout"), from taskDisplayLabel. */
  scope?: string | null;
  /** Short display label, from taskDisplayLabel. */
  title: string;
  /** The raw title, for the hover tooltip. */
  fullTitle?: string;
  pct: number | null;
  href: string;
  waiting?: boolean;
}

/** Other live agents in the same mission (or workspace), with their progress. */
export function AlsoRunning({ title, peers, testId = 'task-also-running' }: { title: string; peers: PeerTask[]; testId?: string }) {
  if (peers.length === 0) return null;
  return (
    <section data-testid={testId}>
      <div className="section-label border-b border-border-default pb-2 mb-1">{title}</div>
      <ul>
        {peers.map(p => (
          <li key={p.taskId} className="border-b border-border-default">
            <Link href={p.href} className="flex items-center gap-3 min-h-12 hover:bg-surface-2">
              <span className={`w-[9px] h-[9px] shrink-0 ${p.waiting ? 'border-2 border-accent' : 'bg-accent'}`} aria-hidden="true" />
              <span className="flex-1 min-w-0 flex items-center gap-2 font-mono text-[13px] text-text-primary" title={p.fullTitle ?? p.title}>
                {p.scope && <span className="shrink-0 px-1.5 border border-border-strong text-[11px] text-text-secondary">{p.scope}</span>}
                <span className="min-w-0 truncate">{p.title}</span>
              </span>
              <span className="w-20 h-[6px] shrink-0 bg-surface-4" aria-label={p.pct != null ? `${p.pct}%` : 'no progress reported'}>
                <span className="block h-full bg-accent" style={{ width: `${Math.max(2, p.pct ?? 0)}%` }} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Mobile stand-in for AlsoRunning: one line, so the question stays the first screen. */
export function AlsoRunningCompact({ count, href }: { count: number; href: string }) {
  if (count <= 0) return null;
  return (
    <Link href={href} data-testid="task-also-running-compact" className="lg:hidden flex items-center gap-3 min-h-11 mt-5 font-mono text-[13px] text-text-secondary">
      <span className="flex gap-[4px]" aria-hidden="true">
        {Array.from({ length: Math.min(count, 6) }, (_, i) => <span key={i} className="w-[14px] h-[14px] bg-accent" />)}
      </span>
      {count} other agent{count === 1 ? '' : 's'} running
    </Link>
  );
}

/** Collapsed-by-default description in the side panel. */
export function SideDescription({ children, preview }: { children: ReactNode; preview: string }) {
  return (
    <details data-testid="task-side-description" className="group border-b border-border-default">
      <summary className="flex items-center gap-3 min-h-12 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className="text-text-muted group-open:rotate-90 transition-transform" aria-hidden="true">▸</span>
        <span className="font-mono text-[11px] uppercase tracking-[2px] text-text-muted shrink-0">Description</span>
        <span className="flex-1 min-w-0 truncate text-[13px] text-text-secondary group-open:hidden">{preview}</span>
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}
