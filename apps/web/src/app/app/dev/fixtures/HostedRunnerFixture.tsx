'use client';

/**
 * `?state=hosted-runner`: every surface of the hosted runner allowance, with
 * made-up numbers. The real pages need a team with cloud run reports (and an
 * allowance) in the database. Top to bottom: the Home banner at 80% and at
 * 100%, the Usage page section with an allowance, without one, and with no runs yet, the
 * workspace settings line, the task detail line, and a task held because the
 * allowance is used.
 */
import { HostedRunnerBanner } from '@/components/hosted-runner/HostedRunnerBanner';
import { HostedRunnerUsageSection, type HostedRunnerWorkspaceRow } from '@/components/hosted-runner/HostedRunnerUsageSection';
import EntitlementBlockedNotice from '@/components/entitlements/EntitlementBlockedNotice';
import RunnerSizeSection from '../../(protected)/settings/workspace/[workspaceId]/RunnerSizeSection';
import {
  forecastMonthEnd,
  hostedRunnerBannerText,
  hostedRunnerMeterView,
  taskRunnerLine,
  workspaceRunnerMonthLine,
} from '@/lib/hosted-runner-usage';
import type { EntitlementBlock } from '@buildd/shared';

// Mid-month, so the forecast has a pace to go on.
const NOW = new Date('2026-10-16T00:00:00Z');
const H = 3600;

const ROWS: HostedRunnerWorkspaceRow[] = [
  { workspaceId: 'a', name: 'web-app', tasks: 14, wallSeconds: 9.1 * H, size: 'large', countedSeconds: 18.2 * H },
  { workspaceId: 'b', name: 'api-service', tasks: 21, wallSeconds: 10.6 * H, size: 'standard', countedSeconds: 10.6 * H },
  { workspaceId: 'c', name: 'docs-site-with-a-long-name', tasks: 5, wallSeconds: 2.4 * H, size: 'mixed', countedSeconds: 3.6 * H },
];
const COUNTED = ROWS.reduce((n, r) => n + r.countedSeconds, 0);

const HELD: EntitlementBlock = {
  kind: 'hosted_runner', key: 'hosted_runner.hours', unit: 'counted_runner_hours',
  used: 50, limit: 50, resetsAt: '2026-11-01T00:00:00.000Z',
};

export default function HostedRunnerFixture() {
  const warn = hostedRunnerBannerText({ allowanceHours: 40, countedSeconds: COUNTED }, NOW)!;
  const used = hostedRunnerBannerText({ allowanceHours: 30, countedSeconds: COUNTED }, NOW)!;
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-10">
        <section className="space-y-2">
          <HostedRunnerBanner level={warn.level} text={warn.text} />
          <HostedRunnerBanner level={used.level} text={used.text} />
        </section>

        <HostedRunnerUsageSection
          meter={hostedRunnerMeterView({ allowanceHours: 50, countedSeconds: COUNTED, forecast: forecastMonthEnd(COUNTED, NOW) }, NOW)}
          rows={ROWS}
        />
        <HostedRunnerUsageSection
          meter={hostedRunnerMeterView({ allowanceHours: null, countedSeconds: 3 * H, forecast: forecastMonthEnd(3 * H, NOW) }, NOW)}
          rows={[{ workspaceId: 'd', name: 'cli', tasks: 4, wallSeconds: 3 * H, size: 'standard', countedSeconds: 3 * H }]}
        />
        <HostedRunnerUsageSection
          meter={hostedRunnerMeterView({ allowanceHours: 50, countedSeconds: 0, forecast: forecastMonthEnd(0, NOW) }, NOW)}
          rows={[]}
        />

        <RunnerSizeSection
          workspaceId="fixture-ws"
          explicit={null}
          effective="large"
          source="derived"
          reason="low_disk"
          monthLine={workspaceRunnerMonthLine({ wallSeconds: 9.1 * H, countedSeconds: 18.2 * H })}
        />

        <p data-testid="task-hosted-runner" className="text-meta text-text-secondary tabular-nums">
          {taskRunnerLine({ size: 'large', wallSeconds: 19 * 60, countedSeconds: 38 * 60 })}
        </p>

        <EntitlementBlockedNotice block={HELD} />
      </div>
    </main>
  );
}
