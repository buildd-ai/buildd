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

  // Build 14-slot array aligned to the latest date in the input
  const slots: (EffortDay | null)[] = Array.from({ length: SLOTS }, () => null);

  if (days.length > 0) {
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const dateMap = new Map(sorted.map(d => [d.date, d]));
    const endDate = new Date(sorted[sorted.length - 1].date + 'T00:00:00Z');
    for (let i = 0; i < SLOTS; i++) {
      const d = new Date(endDate);
      d.setUTCDate(endDate.getUTCDate() - (SLOTS - 1 - i));
      slots[i] = dateMap.get(d.toISOString().slice(0, 10)) ?? null;
    }
  }

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
