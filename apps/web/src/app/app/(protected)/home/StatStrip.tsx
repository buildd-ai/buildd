/**
 * Home's big numbers: agents live (with a slot meter), needs you, merged
 * today, and a fourth slot for what happened beyond merging: PRs in CI, else
 * the fixes that healed on their own, else the screens a visual review
 * checked. A zero there is not news, so with none of them the strip has three.
 */
import { SlotMeter } from '@/components/fleet/SlotMeter';
import { OccupancySparkline } from '@/components/fleet/OccupancySparkline';
import type { OccupancySeries } from '@/lib/fleet-occupancy';

export interface StatStripProps {
  live: number;
  capacity: number;
  runners: number;
  needsYou: number;
  /** "1 question · 1 held" */
  needsYouDetail: string | null;
  mergedToday: number;
  mergedDetail: string | null;
  prsInCi: Array<{ prNumber: number; label: string }>;
  selfHealed: number;
  /** The latest shipped mission's visual review, when it had one. */
  screensReviewed?: { shots: number; ok: number; issues: number; unsure: number } | null;
  /** The last 24h of busy slots, drawn under the slot meter when present. */
  occupancy?: OccupancySeries | null;
}

function Stat({ label, value, children, footer, testId, tone }: { label: string; value: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; testId: string; tone?: 'accent' }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 px-4 py-3.5 md:px-6 md:py-5">
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">{label}</span>
      <span className={`font-mono text-[34px] font-semibold leading-none tracking-[-1px] md:text-[46px] ${tone === 'accent' ? 'text-accent-text' : 'text-text-primary'}`}>
        {value}
      </span>
      <span className="mt-1 flex min-h-4 min-w-0 items-center justify-between gap-2 truncate font-mono text-[11px] text-text-muted md:text-[12px]">{children}</span>
      {footer}
    </div>
  );
}

export function StatStrip(p: StatStripProps) {
  const ci = p.prsInCi.length > 0;
  const screens = p.screensReviewed && p.screensReviewed.shots > 0 ? p.screensReviewed : null;
  const fourth = ci || p.selfHealed > 0 || !!screens;
  return (
    <section
      data-testid="home-stat-strip"
      className={`card mb-6 grid grid-cols-2 divide-border-default md:mb-8 md:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border-default md:[&>*:nth-child(-n+2)]:border-b-0 ${fourth ? 'md:grid-cols-[1.25fr_1fr_1fr_1fr]' : 'md:grid-cols-[1.25fr_1fr_1fr] [&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1'}`}
    >
      <Stat
        testId="stat-agents-live"
        label="Agents live"
        tone={p.live > 0 ? 'accent' : undefined}
        footer={p.occupancy ? <OccupancySparkline series={p.occupancy} capacityNow={p.capacity} href="/app/health/runners" /> : null}
        value={<>{p.live}<span className="ml-1 align-baseline text-[18px] font-normal tracking-normal text-text-muted md:text-[22px]">/{p.capacity}</span></>}
      >
        <SlotMeter live={p.live} max={p.capacity} size="lg" />
        <span className="hidden md:inline">{p.runners} runner{p.runners === 1 ? '' : 's'}</span>
      </Stat>
      <Stat testId="stat-needs-you" label="Needs you" value={p.needsYou}>
        <span className="truncate">{p.needsYouDetail ?? 'nothing waiting'}</span>
      </Stat>
      <Stat testId="stat-merged-today" label="Merged today" value={p.mergedToday}>
        <span className="truncate">{p.mergedDetail ?? 'nothing merged'}</span>
      </Stat>
      {ci ? (
        <Stat testId="stat-prs-in-ci" label="PRs in CI" value={p.prsInCi.length}>
          <span className="truncate">{p.prsInCi.slice(0, 3).map(pr => `#${pr.prNumber}`).join(' ')}</span>
        </Stat>
      ) : p.selfHealed > 0 ? (
        <Stat testId="stat-self-healed" label="Self-healed" value={p.selfHealed}>
          <span className="truncate">fixed by agents today</span>
        </Stat>
      ) : screens ? (
        <Stat testId="stat-screens-reviewed" label="Screens reviewed" value={screens.shots}>
          <span className={`truncate ${screens.ok === screens.shots ? 'text-status-success' : ''}`}>
            {screens.ok === screens.shots
              ? 'all ok'
              : [screens.issues > 0 ? `${screens.issues} issue${screens.issues === 1 ? '' : 's'}` : null, screens.unsure > 0 ? `${screens.unsure} unsure` : null].filter(Boolean).join(' · ')}
          </span>
        </Stat>
      ) : null}
    </section>
  );
}
