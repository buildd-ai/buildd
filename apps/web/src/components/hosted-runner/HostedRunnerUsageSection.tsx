/**
 * Usage page: the team's month on the hosted (cloud) runner. A meter against
 * the allowance, the month-end pace, and one row per workspace by counted
 * hours. Hours only, never compute dollars: model spend is on the team's own
 * key and is not part of this.
 *
 * Presentational and server-safe; the page loads the numbers
 * (lib/hosted-runner-usage-store.ts) and shapes them (lib/hosted-runner-usage.ts).
 */
import Section from '@/components/ui/Section';
import { formatRunnerHours, type HostedRunnerMeterView, type UsageSize } from '@/lib/hosted-runner-usage';

export interface HostedRunnerWorkspaceRow {
  workspaceId: string;
  name: string;
  tasks: number;
  wallSeconds: number;
  size: UsageSize;
  countedSeconds: number;
}

const SIZE_LABEL: Record<UsageSize, string> = { standard: 'Standard', large: 'Large', mixed: 'Mixed' };

export function HostedRunnerUsageSection({ meter, rows }: { meter: HostedRunnerMeterView; rows: HostedRunnerWorkspaceRow[] }) {
  const fill = meter.level === 'used' ? 'bg-status-warning' : 'bg-accent';
  return (
    <div data-testid="hosted-runner-usage" className="mb-8">
      <Section title="Hosted runner · this month">
        <div className="space-y-2">
          <p data-testid="hosted-runner-headline" className="text-title text-text-primary tabular-nums">{meter.headline}</p>
          {meter.percent !== null && (
            <div
              role="meter"
              aria-label="Hosted runner hours used this month"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={meter.percent}
              data-level={meter.level}
              className="h-2 w-full border border-border-default bg-surface-2"
            >
              <div className={`h-full ${fill}`} style={{ width: `${meter.percent}%` }} />
            </div>
          )}
          {meter.forecast && <p data-testid="hosted-runner-forecast" className="text-meta text-text-secondary">{meter.forecast}</p>}
        </div>

        {rows.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table data-testid="hosted-runner-table" className="w-full text-body tabular-nums">
              <thead>
                <tr className="whitespace-nowrap text-meta text-text-muted">
                  <th scope="col" className="py-2 pr-3 text-left font-normal">Workspace</th>
                  <th scope="col" className="py-2 px-2 text-right font-normal">Tasks</th>
                  <th scope="col" className="py-2 px-2 text-right font-normal">Wall h</th>
                  <th scope="col" className="hidden py-2 px-2 text-left font-normal md:table-cell">Size</th>
                  <th scope="col" className="py-2 pl-2 text-right font-normal">Counted h</th>
                </tr>
              </thead>
              {/* Phone: Size drops out (Counted h already carries the 2x), so the
                  number that matters never scrolls off. */}
              <tbody>
                {rows.map(r => (
                  <tr key={r.workspaceId} className="border-t border-border-default">
                    <td className="max-w-[9rem] truncate py-2 pr-3 text-text-primary md:max-w-[16rem]">{r.name}</td>
                    <td className="py-2 px-2 text-right text-text-secondary">{r.tasks}</td>
                    <td className="py-2 px-2 text-right text-text-secondary">{formatRunnerHours(r.wallSeconds)}</td>
                    <td className="hidden py-2 px-2 text-text-secondary md:table-cell">{SIZE_LABEL[r.size]}</td>
                    <td className="py-2 pl-2 text-right font-medium text-text-primary">{formatRunnerHours(r.countedSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-meta text-text-muted">No hosted runs this month.</p>
        )}

        <p className="mt-3 text-meta text-text-muted">Large runs count 2×. Model spend is on your API key and not included.</p>
      </Section>
    </div>
  );
}
