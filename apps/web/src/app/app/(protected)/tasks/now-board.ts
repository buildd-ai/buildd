/**
 * Now as the board draws it (spec 9430a28f r2 R-12..R-15, R-2): the rows of
 * the one shared delivery projection (`ActivityNow`), flattened to one list of
 * deliveries with the StageMeter reading each one shows. The Pipeline, the
 * stage groups, the YouStrip and the rail all read this one list, so a count,
 * its dots and its rows cannot disagree (AC-12). Nothing here derives
 * delivery state: the meter is a reading of `TaskDelivery.kind`.
 */
import type { DeliveryItem } from '@/components/ui/DeliveryRow';
import type { PipelineStage } from '@/components/ui/Pipeline';
import type { StageMeterStage, StageMeterState } from '@/components/ui/StageMeter';
import type { YouStripItem } from '@/components/ui/YouStrip';
import type { TaskDelivery } from '@/lib/delivery-projection';
import type { ActivityNow, NowGroup, NowRow } from '@/lib/activity-delivery';
import { displayTaskTitle } from '@/lib/task-title';

/** One delivery on Now: what its row and card draw, what the Pipeline counts, and the row it came from. */
export interface NowDelivery extends DeliveryItem {
  state: StageMeterState;
  stage?: StageMeterStage;
  row: NowRow;
}

/** The meter a delivery reads. Repair is Verify with its fix rounds, never a stage of its own. */
export function meterOf(d: Pick<TaskDelivery, 'kind' | 'repairRounds' | 'reconciling'>): DeliveryItem['meter'] {
  switch (d.kind) {
    case 'build': return { state: 'build' };
    case 'repair': return { state: 'fixing-in-verify', fixRounds: d.repairRounds };
    case 'audit': return { state: 'verify' };
    case 'unavailable': return { state: 'check-cant-run', stage: 'verify' };
    case 'needs': return { state: 'waiting-on-you', stage: 'verify' };
    case 'landing': case 'landed': return { state: 'deliver' };
    // Closed unmerged: the platform is still looking for the PR that carries it, else a person decides.
    case 'notlanded': return d.reconciling ? { state: 'check-cant-run', stage: 'deliver' } : { state: 'waiting-on-you', stage: 'deliver' };
    default: return { state: 'queued' };
  }
}

const REASON_CHECK: Record<NonNullable<TaskDelivery['repairReason']>, string> = { ci: 'CI failed', conflict: 'branch conflict', review: 'review' };

/** The check a fix is for: the current head's failing gate, else why the repair was started. */
export function failingCheckOf(row: NowRow): string | null {
  const head = row.evidence.find(e => e.type === 'revision' && e.current);
  const gate = head?.type === 'revision' ? head.gates.find(g => g.tone === 'error' && !g.void) : undefined;
  if (gate) return `${gate.name} ${gate.result}`;
  return row.delivery.repairReason ? REASON_CHECK[row.delivery.repairReason] : null;
}

/**
 * Each delivery once, in the projection's attention order: a delivery read
 * twice, or caught mid-move between groups, keeps its first place. Waiting rows
 * folded behind "+N more" are deliveries too, and are counted.
 */
export function nowDeliveries(now: ActivityNow): NowDelivery[] {
  const seen = new Set<string>();
  const out: NowDelivery[] = [];
  for (const g of now.groups) {
    for (const row of [...g.rows, ...g.hiddenWaitingRows]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const meter = meterOf(row.delivery);
      out.push({
        id: row.id,
        title: displayTaskTitle(row.title),
        href: row.href,
        updatedAt: row.updatedAt,
        meter,
        state: meter.state,
        stage: meter.stage,
        missionTitle: g.missionId ? g.title : null,
        failingCheck: meter.state === 'fixing-in-verify' || meter.state === 'fixing-in-build' ? failingCheckOf(row) : null,
        row,
      });
    }
  }
  return out;
}

/** Now's groups, closest to done first (R-14). Queued is last and is not a column on desktop. */
export const NOW_STAGE_ORDER: readonly PipelineStage[] = ['deliver', 'verify', 'build', 'queued'];
export const NOW_STAGE_LABEL: Record<PipelineStage, string> = { deliver: 'Deliver', verify: 'Verify', build: 'Build', queued: 'Queued' };

const retries = (n: number) => `${n} ${n === 1 ? 'retry' : 'retries'}`;

/** What waits on the person, for the YouStrip: every delivery whose meter reads waiting on you. */
export function waitingOnYou(deliveries: readonly NowDelivery[]): YouStripItem[] {
  return deliveries
    .filter(d => d.state === 'waiting-on-you')
    .map(d => {
      const rounds = d.row.delivery.repairRounds;
      const what = d.row.delivery.kind === 'notlanded' ? 'Closed unmerged' : 'Review';
      return { id: d.id, title: d.title, href: d.href, reason: rounds > 0 ? `${what} · ${retries(rounds)}` : what };
    });
}

/** One mission's segment in the rail's strip: merged, its open deliveries by meter, then not started. */
export type MissionSegment = 'merged' | 'build' | 'verify' | 'fixing' | 'deliver' | 'waiting' | 'todo';

export interface MissionInMotion {
  id: string;
  title: string;
  href: string | null;
  landed: number;
  total: number;
  segments: MissionSegment[];
}

/** The strip is a picture, not a ledger: past this many segments it stops drawing. */
export const MISSION_STRIP_CAP = 24;

function segmentOf(state: StageMeterState): MissionSegment {
  switch (state) {
    case 'fixing-in-build': case 'fixing-in-verify': return 'fixing';
    case 'waiting-on-you': return 'waiting';
    case 'verify': case 'check-cant-run': return 'verify';
    case 'deliver': return 'deliver';
    case 'build': return 'build';
    default: return 'todo';
  }
}

/** The rail's "Missions in motion": every mission with a delivery on Now, read from the same deliveries. */
export function missionsInMotion(now: ActivityNow, deliveries: readonly NowDelivery[]): MissionInMotion[] {
  const byId = new Map(deliveries.map(d => [d.id, d]));
  return now.groups
    .filter((g): g is NowGroup & { missionId: string } => g.missionId != null)
    .map(g => {
      const mine = [...g.rows, ...g.hiddenWaitingRows].map(r => byId.get(r.id)).filter((d): d is NowDelivery => !!d);
      const total = Math.max(g.total, g.landed + mine.length);
      // Open work is drawn first when the strip is capped; merged and not-started fill what is left.
      const open = mine.map(d => segmentOf(d.state)).slice(0, MISSION_STRIP_CAP);
      const merged = Math.min(g.landed, MISSION_STRIP_CAP - open.length);
      const todo = Math.min(Math.max(0, total - g.landed - mine.length), MISSION_STRIP_CAP - open.length - merged);
      const segments: MissionSegment[] = [
        ...Array<MissionSegment>(merged).fill('merged'),
        ...open,
        ...Array<MissionSegment>(todo).fill('todo'),
      ];
      return { id: g.missionId, title: g.title, href: g.href, landed: g.landed, total, segments, open: mine.length };
    })
    .filter(m => m.open > 0)
    .map(({ open: _open, ...m }) => m);
}
