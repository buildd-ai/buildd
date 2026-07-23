import Link from 'next/link';
import type { MissionSegment } from '@buildd/core/mission-helpers';
import { deriveDriveState, getDrivePresentation, selectInFlightTasks, type Health, type InFlightTask } from '@/lib/mission-helpers';
import { SegmentStrip } from './SegmentStrip';

const healthTone = { BLOCKED: 'border-status-warning text-status-warning', FAILING: 'border-status-error text-status-error', STALLED: 'border-status-warning text-status-warning' } as const;

export function MissionBadges({ mission, health, nextRun }: { mission: { status: string; orchestrationMode?: string | null; lastDeferralReason?: string | null; lastDeferredAt?: string | null }; health: Health; nextRun: { text: string; urgency: unknown } }) {
  const drive = getDrivePresentation(deriveDriveState(mission), nextRun as any);
  const driveTone = drive.tone === 'warning' ? 'border-status-warning text-status-warning' : drive.tone === 'info' ? 'border-status-info text-status-info' : 'border-border-default text-text-muted';
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide"><span className={`shrink-0 border px-1.5 py-0.5 ${driveTone}`}>{drive.label}</span>{drive.detail && <span className="min-w-0 normal-case tracking-normal text-text-muted">{drive.detail}</span>}{health !== 'NOMINAL' && <span className={`shrink-0 border px-1.5 py-0.5 ${healthTone[health]}`}>{health}</span>}</div>;
}

export function MissionProgress({ missionId, segments, completedTasks, totalTasks, inFlightTasks = [] }: { missionId: string; segments: MissionSegment[]; completedTasks: number; totalTasks: number; inFlightTasks?: InFlightTask[] }) {
  const { primary, overflow } = selectInFlightTasks(inFlightTasks);
  const order = { solid: 0, half: 1, ghost: 2, notch: 3, empty: 4 };
  const projected = [...segments].sort((a, b) => order[a.state] - order[b.state]);
  return <div className="min-w-0 space-y-1.5"><div className="flex min-w-0 items-center gap-2"><SegmentStrip segments={projected} label={`${completedTasks} of ${totalTasks} tasks complete`} /><span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">{completedTasks}/{totalTasks}</span></div>{primary && <div className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-text-muted"><Link href={`/app/tasks/${primary.id}`} className="min-w-0 truncate hover:text-accent-text">▸ {primary.title} — {primary.meta}</Link>{overflow > 0 && <Link href={`/app/missions/${missionId}?tab=tasks`} className="shrink-0 hover:text-accent-text">+{overflow}</Link>}</div>}</div>;
}
