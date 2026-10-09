/**
 * One row per open mission on a shared calendar axis, weekends shaded. Solid
 * is time so far, hatched is the estimate (p50), the thin line is if it runs
 * long (p80), green dashes are release cuts, and an elbow joins a mission to
 * the one it waits on. Rows are hairlines, not boxes, and link to the
 * mission's Flow. Server-rendered: nothing here needs the client.
 */
import Link from 'next/link';
import { missionLayoutHref } from '@/lib/mission-layout';
import { planRowLabel, type PlanAxis, type PlanRow } from '@/lib/mission-plan';

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
const HATCH = 'repeating-linear-gradient(135deg, var(--text-muted) 0 1.5px, transparent 1.5px 5px)';

function Bars({ row, axis, cuts, now }: { row: PlanRow; axis: PlanAxis; cuts: readonly number[]; now: number }) {
  const solidTo = row.soFarEnd ?? row.start;
  return (
    <div className="relative h-5 w-full" role="img" aria-label={barSummary(row, now)}>
      {axis.days.filter(d => d.weekend).map(d => (
        <span key={d.at} data-testid="plan-weekend" className="absolute inset-y-0" style={{ left: pct(axis.at(d.at)), width: pct(axis.at(d.at + 86_400_000) - axis.at(d.at)), background: 'var(--q-tint)' }} />
      ))}
      {cuts.map(c => (
        <span key={c} data-testid="plan-cut" className="absolute inset-y-0 border-l border-dashed" style={{ left: pct(axis.at(c)), borderColor: 'var(--status-success)' }} />
      ))}
      <span aria-hidden className="absolute inset-y-0 w-px" style={{ left: pct(axis.at(now)), background: 'var(--accent)' }} />
      {row.afterEnd != null && (
        <span data-testid="plan-elbow" aria-hidden className="absolute bottom-1/2 border-b border-l" style={{ left: pct(axis.at(row.afterEnd)), width: pct(Math.max(0, axis.at(row.start) - axis.at(row.afterEnd))), height: '60%', borderColor: 'var(--faint)' }} />
      )}
      {row.soFarEnd != null && (
        <span data-testid="plan-so-far" className="absolute top-[5px] h-2.5" style={{ left: pct(axis.at(row.start)), width: pct(axis.at(solidTo) - axis.at(row.start)), background: 'var(--text-secondary)' }} />
      )}
      {row.p50 != null && (
        <span data-testid="plan-estimate" className="absolute top-[5px] h-2.5 border" style={{ left: pct(axis.at(solidTo)), width: pct(axis.at(row.p50) - axis.at(solidTo)), backgroundImage: HATCH, borderColor: 'var(--text-muted)' }} />
      )}
      {row.p50 != null && row.p80 != null && row.p80 > row.p50 && (
        <span data-testid="plan-long-run" className="absolute top-[9px] h-px" style={{ left: pct(axis.at(row.p50)), width: pct(axis.at(row.p80) - axis.at(row.p50)), background: 'var(--text-muted)' }} />
      )}
    </div>
  );
}

function barSummary(row: PlanRow, now: number): string {
  if (row.p50 == null) return `${row.title}: no estimate`;
  return `${row.title}: est. finish ${new Date(row.p50).toUTCString().slice(0, 16)}`;
}

export default function MissionPlanChart({ rows, axis, cuts, now }: { rows: readonly PlanRow[]; axis: PlanAxis; cuts: readonly number[]; now: number }) {
  const cols = 'md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,12rem)]';
  const sparse = axis.days.length > 8;
  return (
    <div data-testid="mission-plan" className="min-w-0">
      <div className={`hidden md:grid ${cols} md:gap-x-4 pb-1`} aria-hidden>
        <span />
        <div className="relative h-4">
          {axis.days.map(d => (
            (!sparse || d.label === 'Mon') && (
              <span key={d.at} className="absolute font-mono text-[10px] text-text-muted" style={{ left: pct(axis.at(d.at)) }}>{d.label} {d.date}</span>
            )
          ))}
        </div>
        <span />
      </div>
      <ol className="m-0 list-none p-0">
        {rows.map(row => {
          const label = planRowLabel(row, now);
          const atRisk = row.fit?.kind === 'cut' && row.fit.atRisk;
          return (
            <li key={row.id} className="border-t border-border-default">
              <Link
                href={missionLayoutHref(row.href, 'flow')}
                data-testid="plan-row"
                className={`grid min-h-11 grid-cols-1 gap-x-4 gap-y-1 py-3 text-inherit no-underline ${cols} md:items-center`}
              >
                <span className="min-w-0 truncate text-body text-text-primary">{row.title}</span>
                <Bars row={row} axis={axis} cuts={cuts} now={now} />
                <span data-testid="plan-label" className={`font-mono text-meta md:text-right ${atRisk ? 'text-status-warning' : 'text-text-muted'}`}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-meta text-text-muted">
        Solid is time so far, hatched is the estimate, the thin line is if it runs long, dashes are release cuts. Estimates are est.; days are UTC.
      </p>
    </div>
  );
}
