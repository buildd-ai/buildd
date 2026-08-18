export interface EffortDay {
  date: string;    // YYYY-MM-DD
  tokens: number;
  merged: number;
  failed: number;
  open: number;
}

interface SparklineBarProps {
  days: EffortDay[];   // 14-day window, may have gaps
  width?: number;      // default 48
  height?: number;     // default 16
  className?: string;
}

const SLOTS = 14;
const GAP = 1;
const RADIUS = 1;

export function SparklineBar({ days, width = 48, height = 16, className }: SparklineBarProps) {
  const H = height;
  const barW = Math.max(2, (width - (SLOTS - 1) * GAP) / SLOTS);

  // Slots are positional: the last entry of `days` is the rightmost bar.
  //
  // This deliberately does NOT align to the latest date present in the input —
  // spec §6.4 forbids it. That alignment drew a six-day-old burst at the
  // right-hand edge, so an initiative that had been silent all week read as busy.
  // The loader now supplies a dense 14-entry window anchored on today
  // (`buildEffortWindow`), which is what makes positional slots correct.
  //
  // A short input is padded on the left, so the newest entry stays at the edge
  // and a caller passing fewer than 14 days under-claims rather than shifting
  // history sideways.
  const slots: (EffortDay | null)[] = Array.from({ length: SLOTS }, () => null);
  // Sorted by date so "oldest → newest" holds even for an unordered caller, but
  // the slot a day lands in comes from its position, never from its date.
  const recent = [...days].sort((a, b) => a.date.localeCompare(b.date)).slice(-SLOTS);
  const offset = SLOTS - recent.length;
  for (let i = 0; i < recent.length; i++) slots[offset + i] = recent[i];

  const maxTokens = Math.max(...slots.map(s => s?.tokens ?? 0), 1);

  return (
    <svg
      width={width}
      height={H}
      viewBox={`0 0 ${width} ${H}`}
      aria-hidden="true"
      className={className}
    >
      {slots.map((day, i) => {
        const x = i * (barW + GAP);

        if (!day || day.tokens === 0) {
          return (
            <rect
              key={i}
              x={x}
              y={H - 2}
              width={barW}
              height={2}
              fill="var(--accent)"
              opacity={0.25}
              rx={RADIUS}
            />
          );
        }

        const barH = Math.max(2, Math.round((day.tokens / maxTokens) * H));
        const barTop = H - barH;

        // Segment heights: top=merged (success), mid=failed (error), bot=open (accent)
        const total = day.merged + day.failed + day.open;
        let mergedH: number, failedH: number, openH: number;
        if (total === 0) {
          mergedH = 0; failedH = 0; openH = barH;
        } else {
          mergedH = Math.round((day.merged / total) * barH);
          failedH = Math.round((day.failed / total) * barH);
          openH = barH - mergedH - failedH;
        }

        type Seg = { color: string; h: number; y: number; isTop: boolean };
        const segs: Seg[] = [];
        let isFirst = true;
        let curY = barTop;

        if (mergedH > 0) {
          segs.push({ color: 'var(--status-success)', h: mergedH, y: curY, isTop: isFirst });
          curY += mergedH; isFirst = false;
        }
        if (failedH > 0) {
          segs.push({ color: 'var(--status-error)', h: failedH, y: curY, isTop: isFirst });
          curY += failedH; isFirst = false;
        }
        if (openH > 0) {
          segs.push({ color: 'var(--accent)', h: openH, y: curY, isTop: isFirst });
        }

        return (
          <g key={i}>
            {segs.map((seg, j) => {
              const isLast = j === segs.length - 1;
              // Extend topmost segment into next to hide its rounded bottom corners
              const ext = seg.isTop && !isLast ? RADIUS : 0;
              return (
                <rect
                  key={j}
                  x={x}
                  y={seg.y}
                  width={barW}
                  height={seg.h + ext}
                  fill={seg.color}
                  rx={seg.isTop ? RADIUS : 0}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
