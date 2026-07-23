'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  deriveDisplayStatus,
  deriveTimestampLabel,
  isStaleWorker,
  type ChainPositionResult,
  type IntensityResult,
  type IntensityTier,
} from '@/lib/task-presentation';
import { SegmentStrip } from '@/components/SegmentStrip';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskCardProps {
  id: string;
  title: string;

  taskStatus: string;
  workerStatus?: string | null;

  // Tier 1 — Identity
  missionId?: string | null;
  missionTitle?: string | null;
  workspaceName?: string | null;

  // Tier 2 — Position (pre-computed via deriveChainPosition)
  chain?: ChainPositionResult | null;

  // Tier 3 — Health (raw timestamps; elapsed ticks from workerStartedAt)
  taskCreatedAt: string;
  taskUpdatedAt: string;
  workerStartedAt?: string | null;
  workerUpdatedAt?: string | null;

  // Tier 3 — Intensity (pre-computed via deriveIntensity)
  intensity?: IntensityResult | null;

  // Tier 3 — Attempt
  attemptCurrent?: number | null;
  attemptTotal?: number | null;

  // Tier 4 — Provenance
  runnerName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prLifecycleStatus?: string | null;

  // Agent current action (shown in inline density when running)
  currentAction?: string | null;

  density: 'full' | 'row' | 'inline';
}

// ─── Chain strip ─────────────────────────────────────────────────────────────

function ChainStrip({ chain }: { chain: ChainPositionResult }) {
  // Standalone task with no deps and no dependents: omit — never render 1/1.
  if (chain.total === 1) return null;

  return (
    <div className="flex items-center gap-1">
      <SegmentStrip segments={chain.segments} continuous={false} />
      <span className="font-mono text-[10px] text-text-muted tabular-nums">
        {chain.index}/{chain.total}
      </span>
    </div>
  );
}

// ─── Status pill ─────────────────────────────────────────────────────────────

const STATUS_PILL: Record<string, { label: string; cls: string; pulse?: boolean }> = {
  running:       { label: 'Running',       cls: 'text-status-running border-status-running',    pulse: true },
  waiting_input: { label: 'Needs Input',   cls: 'text-status-warning border-status-warning' },
  completed:     { label: 'Done',          cls: 'text-status-success border-status-success' },
  failed:        { label: 'Failed',        cls: 'text-status-error border-status-error' },
  cancelled:     { label: 'Cancelled',     cls: 'text-text-muted border-border-default' },
  pending:       { label: 'Queued',        cls: 'text-text-muted border-border-default' },
  assigned:      { label: 'Assigned',      cls: 'text-status-info border-status-info' },
};

function StatusPill({ displayStatus }: { displayStatus: string }) {
  const config = STATUS_PILL[displayStatus] ?? { label: displayStatus, cls: 'text-text-muted border-border-default' };
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide border ${config.cls} shrink-0`}
    >
      {config.pulse && (
        <span className="w-1.5 h-1.5 bg-current animate-status-pulse flex-shrink-0" />
      )}
      {config.label}
    </span>
  );
}

// ─── Intensity tier → elapsed color ──────────────────────────────────────────

// PR lifecycle pills (mirrors mission page)
const PR_LIFECYCLE: Record<string, { label: string; cls: string }> = {
  merged:     { label: 'merged',    cls: 'bg-status-success/12 text-status-success' },
  ci_running: { label: 'CI…',       cls: 'bg-status-info/12 text-status-info' },
  ci_failed:  { label: 'CI ✗',      cls: 'bg-status-error/12 text-status-error' },
  conflict:   { label: 'conflict',  cls: 'bg-status-warning/12 text-status-warning' },
  closed:     { label: 'closed',    cls: 'bg-text-muted/10 text-text-muted' },
  pr_open:    { label: 'open',      cls: 'bg-accent/12 text-accent-text' },
};

const TIER_COLOR: Record<IntensityTier, string> = {
  fresh:   'text-status-success',
  working: 'text-text-secondary',
  slow:    'text-status-warning',
  stalled: 'text-status-error',
};

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, tier }: { data: number[]; tier: IntensityTier }) {
  if (data.length === 0) return null;
  const max = Math.max(...data, 1);
  const BAR_W = 3;
  const GAP = 1;
  const H = 14;
  const totalW = data.length * (BAR_W + GAP) - GAP;
  const barColor = tier === 'stalled' ? 'var(--status-error)' : tier === 'slow' ? 'var(--status-warning)' : 'var(--accent)';

  return (
    <svg
      width={totalW}
      height={H}
      viewBox={`0 0 ${totalW} ${H}`}
      aria-hidden="true"
      className="shrink-0 self-end"
    >
      {data.map((v, i) => {
        const barH = Math.max(2, Math.round((v / max) * H));
        const x = i * (BAR_W + GAP);
        const y = H - barH;
        return <rect key={i} x={x} y={y} width={BAR_W} height={barH} fill={barColor} opacity={v === 0 ? 0.25 : 1} />;
      })}
    </svg>
  );
}

// ─── Elapsed label ────────────────────────────────────────────────────────────

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    // Align to wall clock so multiple components tick together.
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TaskCard({
  id,
  title,
  taskStatus,
  workerStatus,
  missionId,
  missionTitle,
  workspaceName,
  chain,
  taskCreatedAt,
  taskUpdatedAt,
  workerStartedAt,
  workerUpdatedAt,
  intensity,
  attemptCurrent,
  attemptTotal,
  runnerName,
  prUrl,
  prNumber,
  prLifecycleStatus,
  currentAction,
  density,
}: TaskCardProps) {
  const now = useNow();
  const displayStatus = deriveDisplayStatus(taskStatus, workerStatus);
  const stale = isStaleWorker(workerStatus, workerUpdatedAt, now);

  const timestampLabel = deriveTimestampLabel({
    taskStatus,
    workerStatus,
    taskCreatedAt,
    taskUpdatedAt,
    workerStartedAt,
    workerUpdatedAt,
    now,
  });

  const href = `/app/tasks/${id}`;
  const showAttempt = (attemptCurrent ?? 0) >= 2;
  const tierColor = intensity ? TIER_COLOR[intensity.tier] : 'text-text-secondary';

  // ─── INLINE density — mission timeline row ────────────────────────────────
  // Tiers: 1 (identity), 2 (position), 4 (provenance).
  if (density === 'inline') {
    const lifecycle = prLifecycleStatus ? PR_LIFECYCLE[prLifecycleStatus] : null;
    return (
      <div className="relative group flex items-center gap-2 py-1.5 min-w-0">
        {/* Link overlay */}
        <Link href={href} className="absolute inset-0 z-0" aria-label={title} />

        {/* T2 — chain strip (left anchor) */}
        {chain && chain.total > 1 && (
          <div className="shrink-0 pointer-events-none">
            <ChainStrip chain={chain} />
          </div>
        )}

        {/* T1 — title + currentAction */}
        <span className="flex-1 min-w-0 pointer-events-none group-hover:text-accent-text transition-colors">
          <span className={`text-[13px] truncate block ${displayStatus === 'completed' ? 'text-text-secondary' : 'text-text-primary'}`}>
            {title}
          </span>
          {displayStatus === 'running' && currentAction && (
            <span className="text-[11px] text-status-info truncate block">{currentAction}</span>
          )}
        </span>

        {/* T3 — status */}
        <div className="pointer-events-none shrink-0">
          <StatusPill displayStatus={displayStatus} />
        </div>

        {/* T4 — PR link + lifecycle (restores pointer events) */}
        {prUrl && (
          <span className="shrink-0 flex items-center gap-1">
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 pointer-events-auto font-mono text-[10px] text-accent-text hover:underline"
            >
              #{prNumber}↗
            </a>
            {lifecycle && (
              <span className={`text-[10px] font-medium px-1 py-0.5 rounded pointer-events-none ${lifecycle.cls}`}>
                {lifecycle.label}
              </span>
            )}
          </span>
        )}

        {/* T4 — runner (last) */}
        {runnerName && (
          <span className="font-mono text-[9px] text-text-muted truncate shrink-0 max-w-[80px] pointer-events-none">
            {runnerName}
          </span>
        )}
      </div>
    );
  }

  // ─── ROW density — activity list ─────────────────────────────────────────
  // Tiers 1–4, sparkline optional.
  if (density === 'row') {
    return (
      <div className="relative group flex items-start gap-3 px-3 py-2.5 min-w-0 border-b border-border-default last:border-b-0 hover:bg-surface-3 transition-colors">
        {/* Link overlay */}
        <Link href={href} className="absolute inset-0 z-0" aria-label={title} />

        {/* T2 — chain strip (left, stacked) */}
        <div className="shrink-0 pt-0.5 pointer-events-none">
          {chain && chain.total > 1 ? (
            <ChainStrip chain={chain} />
          ) : (
            // placeholder keeps rows aligned when some have chains and some don't
            <div className="w-4 h-4" />
          )}
        </div>

        {/* Center — identity + secondary */}
        <div className="flex-1 min-w-0 pointer-events-none">
          {/* T1 — title */}
          <div className="text-[13px] font-medium text-text-primary truncate group-hover:text-accent-text transition-colors">
            {title}
          </div>

          {/* T1 — mission + workspace */}
          {(missionTitle || workspaceName) && (
            <div className="text-[11px] text-text-muted mt-0.5 truncate">
              {missionTitle && <span>{missionTitle}</span>}
              {missionTitle && workspaceName && <span className="mx-1">·</span>}
              {workspaceName && <span className="font-mono uppercase tracking-wide text-[9px]">{workspaceName}</span>}
            </div>
          )}

          {/* T2 — blocked-by text */}
          {chain && chain.blockedBy.length > 0 && (
            <div className="text-[10px] text-status-warning mt-0.5 truncate">
              {'← blocked on '}
              {chain.blockedBy.map((b, i) => (
                <span key={b.id}>
                  {i > 0 && ', '}
                  {b.prNumber ? `#${b.prNumber}` : b.title}
                  {b.prUrl ? ' (open)' : ''}
                </span>
              ))}
            </div>
          )}

          {/* T4 — runner (last in DOM) */}
          {runnerName && (
            <div className="font-mono text-[10px] text-text-muted mt-0.5 truncate">{runnerName}</div>
          )}
        </div>

        {/* Right — health + provenance */}
        <div className="shrink-0 flex flex-col items-end gap-1 pointer-events-none">
          <StatusPill displayStatus={displayStatus} />

          {/* T3 — elapsed */}
          <span className={`font-mono text-[10px] tabular-nums ${tierColor}`}>
            {timestampLabel}
            {stale && <span className="ml-1 text-status-warning">!</span>}
          </span>

          {/* T3 — sparkline + attempt */}
          <div className="flex items-end gap-2">
            {intensity && intensity.sparkline.length > 0 && (
              <Sparkline data={intensity.sparkline} tier={intensity.tier} />
            )}
            {showAttempt && (
              <span className="font-mono text-[10px] text-text-muted tabular-nums">
                {attemptCurrent}/{attemptTotal}
              </span>
            )}
          </div>

          {/* T4 — PR link */}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 pointer-events-auto font-mono text-[10px] text-accent-text hover:underline"
            >
              PR #{prNumber}↗
            </a>
          )}
        </div>
      </div>
    );
  }

  // ─── FULL density — Home Right Now ───────────────────────────────────────
  // All tiers.
  return (
    <div className="relative group border-l-2 border-accent bg-card-rightnow px-4 py-3 min-w-0 hover:bg-surface-3 transition-colors">
      {/* Link overlay */}
      <Link href={href} className="absolute inset-0 z-0" aria-label={title} />

      {/* T1 — title + status pill (top row) */}
      <div className="flex items-start justify-between gap-3 mb-0.5 pointer-events-none">
        <div className="text-[15px] font-medium text-text-primary truncate group-hover:text-accent-text transition-colors flex-1 min-w-0">
          {title}
        </div>
        <StatusPill displayStatus={displayStatus} />
      </div>

      {/* T1 — mission + workspace (second row) */}
      {(missionTitle || workspaceName) && (
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted mb-1.5 pointer-events-none">
          {missionTitle && (
            <span className="truncate">{missionTitle}</span>
          )}
          {missionTitle && workspaceName && <span className="shrink-0">·</span>}
          {workspaceName && (
            <span className="font-mono text-[9px] uppercase tracking-wide shrink-0">{workspaceName}</span>
          )}
        </div>
      )}

      {/* T2 — chain strip + unblocks */}
      {chain && chain.total > 1 && (
        <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 mb-1.5 pointer-events-none">
          <ChainStrip chain={chain} />
          {chain.blockedBy.length > 0 && (
            <span className="text-[10px] text-status-warning truncate">
              {'← blocked on '}
              {chain.blockedBy.map((b, i) => (
                <span key={b.id}>
                  {i > 0 && ', '}
                  {b.prNumber ? `#${b.prNumber}` : b.title}
                  {b.prUrl ? ' (open)' : ''}
                </span>
              ))}
            </span>
          )}
          {chain.unblocks > 0 && chain.blockedBy.length === 0 && (
            <span className="text-[10px] text-text-muted">
              → unblocks {chain.unblocks}
            </span>
          )}
        </div>
      )}

      {/* T3 — elapsed + sparkline + attempt + stale */}
      <div className="flex items-center gap-3 mb-1.5 pointer-events-none">
        <span className={`font-mono text-[11px] tabular-nums ${tierColor}`}>
          {timestampLabel}
        </span>
        {stale && (
          <span className="font-mono text-[10px] text-status-warning uppercase tracking-wide">stale</span>
        )}
        {intensity && intensity.sparkline.length > 0 && (
          <Sparkline data={intensity.sparkline} tier={intensity.tier} />
        )}
        {showAttempt && (
          <span className="font-mono text-[10px] text-text-muted tabular-nums">
            attempt {attemptCurrent}/{attemptTotal}
          </span>
        )}
      </div>

      {/* T4 — runner (last) + PR link */}
      <div className="flex items-center justify-between gap-2">
        {runnerName ? (
          <span className="font-mono text-[10px] text-text-muted truncate pointer-events-none">{runnerName}</span>
        ) : (
          <span />
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 pointer-events-auto font-mono text-[10px] text-accent-text hover:underline shrink-0"
          >
            PR #{prNumber}↗
          </a>
        )}
      </div>
    </div>
  );
}

export default TaskCard;
