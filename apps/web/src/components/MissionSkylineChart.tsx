import type { MissionSkylineData, SkylineBlockState } from '@buildd/core/mission-helpers';

const STATE_BG: Record<SkylineBlockState, string> = {
  merged: 'bg-status-success',
  awaiting: 'bg-status-warning',
  failed: 'bg-status-error',
};

// px reserved on the right for the compressed tail visual
const TAIL_WIDTH_PX = 44;
const LANE_H = 11;
const MAX_VISIBLE_LANES = 4;

function formatDuration(min: number): string {
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function HatchBlock() {
  return (
    <div
      className="flex-none w-[4px] bg-status-warning/40"
      style={{
        height: `${LANE_H - 2}px`,
        backgroundImage:
          'repeating-linear-gradient(135deg, rgba(0,0,0,0.35) 0 1px, transparent 1px 3px)',
      }}
    />
  );
}

interface Props {
  skyline: MissionSkylineData;
  /** Max totalSlots across sibling missions in the same initiative — normalizes x-axis width. */
  normalizationSlots?: number;
}

export function MissionSkylineChart({ skyline, normalizationSlots }: Props) {
  const normSlots = Math.max(skyline.totalSlots, normalizationSlots ?? 0);
  const hasTail = (skyline.reviewTailMin ?? 0) > 0;
  const visibleLanes = Math.min(skyline.peakLanes, MAX_VISIBLE_LANES);

  // Group blocks by lane, cap at MAX_VISIBLE_LANES
  const byLane = new Map<number, typeof skyline.blocks>();
  for (const block of skyline.blocks) {
    if (block.lane >= MAX_VISIBLE_LANES) continue;
    if (!byLane.has(block.lane)) byLane.set(block.lane, []);
    byLane.get(block.lane)!.push(block);
  }

  // Work area width: subtract tail space when tail is shown
  const workAreaStyle = hasTail
    ? { width: `calc(100% - ${TAIL_WIDTH_PX}px)` }
    : { width: '100%' };

  const showParallel = skyline.peakConcurrency > 1;
  const mainText = [
    `${formatDuration(skyline.activeSpanMin)} active`,
    `${formatDuration(skyline.agentTimeMin)} agent time`,
    showParallel
      ? `${skyline.parallelFactor.toFixed(1)}× parallel, peak ${skyline.peakConcurrency}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-1">
      {/* Lane rows */}
      <div className="space-y-[2px]">
        {Array.from({ length: visibleLanes }, (_, laneIdx) => {
          const laneBlocks = byLane.get(laneIdx) ?? [];
          return (
            <div key={laneIdx} className="flex items-stretch">
              {/* Work area */}
              <div
                className="relative flex-none"
                style={{ ...workAreaStyle, height: `${LANE_H}px` }}
              >
                {laneBlocks.map((block, i) => {
                  const slotCount = block.endSlot - block.startSlot;
                  const leftPct = (block.startSlot / normSlots) * 100;
                  const widthPct = (slotCount / normSlots) * 100;
                  // Hairline seams at 15m boundaries for multi-slot blocks
                  const seamsStyle =
                    slotCount > 1
                      ? {
                          backgroundImage: `repeating-linear-gradient(90deg, transparent calc(${(100 / slotCount).toFixed(3)}% - 1px), rgba(0,0,0,0.22) calc(${(100 / slotCount).toFixed(3)}% - 1px))`,
                        }
                      : undefined;
                  return (
                    <div
                      key={i}
                      className={`absolute top-0 h-full ${STATE_BG[block.state]}`}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%`, ...seamsStyle }}
                    />
                  );
                })}
              </div>

              {/* Tail area: hatched on lane 0, spacer on other lanes */}
              {hasTail && (
                <div
                  className="flex-none flex items-center"
                  style={{ width: `${TAIL_WIDTH_PX}px`, height: `${LANE_H}px` }}
                >
                  {laneIdx === 0 ? (
                    <div className="flex items-center gap-[1px] pl-[3px]">
                      <HatchBlock />
                      <HatchBlock />
                      <HatchBlock />
                      <span className="text-[7px] text-status-warning/60 leading-none px-[1px]">
                        ···
                      </span>
                      <HatchBlock />
                      <HatchBlock />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Folded-lane count */}
      {skyline.foldedLanes > 0 && (
        <div className="font-mono text-[10px] text-text-muted">
          +{skyline.foldedLanes} more lane{skyline.foldedLanes > 1 ? 's' : ''}
        </div>
      )}

      {/* Text line: stats */}
      <div className="font-mono text-[10px] text-text-muted leading-tight">{mainText}</div>
      {hasTail && skyline.reviewTailMin && skyline.reviewTailMin > 0 && (
        <div className="font-mono text-[10px] text-text-muted leading-tight">
          {formatDuration(skyline.reviewTailMin)} waiting on review
        </div>
      )}
    </div>
  );
}
