import Link from 'next/link';
import type { MissionSegment } from '@buildd/core/mission-helpers';
import { deriveDriveState, getDrivePresentation, selectInFlightTasks, type Health, type InFlightTask } from '@/lib/mission-helpers';
import { SegmentStrip } from './SegmentStrip';

const healthTone = { BLOCKED: 'border-status-warning text-status-warning', FAILING: 'border-status-error text-status-error', STALLED: 'border-status-warning text-status-warning' } as const;

export function MissionBadges({ mission, health, nextRun, isReviewReady }: { mission: { status: string; orchestrationMode?: string | null; lastDeferralReason?: string | null; lastDeferredAt?: string | null }; health: Health; nextRun: { text: string; urgency: unknown }; isReviewReady?: boolean }) {
  if (isReviewReady) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide">
        <span className="shrink-0 border px-1.5 py-0.5 border-status-success text-status-success">Ready for review</span>
      </div>
    );
  }
  const driveState = deriveDriveState(mission);
  const drive = getDrivePresentation(driveState, nextRun as any);
  // When the mission is COMPLETE, health issues are historical noise — render a
  // small warning icon rather than a peer badge.
  const isComplete = driveState === 'COMPLETE';
  const hasHealthIssue = health !== 'NOMINAL' && !isComplete;

  // One-pill rule: drive and health must never both appear as bordered chips.
  // When drive is AUTO, health is the more actionable signal — promote it to chip.
  // For all other drive states (SEATS_FULL, MANUAL, etc.), keep the drive chip and
  // fold health into the detail text as a plain-language suffix.
  let chipLabel: string;
  let chipClass: string;
  let detail: string;
  if (hasHealthIssue && driveState === 'AUTO') {
    chipLabel = health;
    chipClass = healthTone[health];
    detail = drive.detail;
  } else {
    chipClass = drive.tone === 'warning' ? 'border-status-warning text-status-warning' : drive.tone === 'info' ? 'border-status-info text-status-info' : 'border-border-default text-text-muted';
    chipLabel = drive.label;
    detail = hasHealthIssue
      ? `${drive.detail}${drive.detail ? ' · ' : ''}${health.charAt(0) + health.slice(1).toLowerCase()}`
      : drive.detail;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide">
      <span className={`shrink-0 border px-1.5 py-0.5 ${chipClass}`}>{chipLabel}</span>
      {detail && <span className="min-w-0 normal-case tracking-normal text-text-muted">{detail}</span>}
      {health !== 'NOMINAL' && isComplete && <span className="shrink-0 text-status-warning" title={`${health} — some tasks ended with issues`}>⚠</span>}
    </div>
  );
}

export function MissionProgress({ missionId, segments, completedTasks, totalTasks, inFlightTasks = [] }: { missionId: string; segments: MissionSegment[]; completedTasks: number; totalTasks: number; inFlightTasks?: InFlightTask[] }) {
  const { primary, overflow } = selectInFlightTasks(inFlightTasks);
  const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 };
  const projected = [...segments].sort((a, b) => order[a.state] - order[b.state]);
  return <div className="min-w-0 space-y-1.5"><div className="flex min-w-0 items-center gap-2"><SegmentStrip segments={projected} label={`${completedTasks} of ${totalTasks} tasks complete`} /><span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">{completedTasks}/{totalTasks}</span></div>{primary && <div className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-text-muted"><Link href={`/app/tasks/${primary.id}`} className="min-w-0 truncate hover:text-accent-text">▸ {primary.title} — {primary.meta}</Link>{overflow > 0 && <Link href={`/app/missions/${missionId}?tab=tasks`} className="shrink-0 hover:text-accent-text">+{overflow}</Link>}</div>}</div>;
}
