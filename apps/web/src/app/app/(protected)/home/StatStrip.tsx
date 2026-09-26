/**
 * Home's four big numbers: agents live (with a slot meter), needs you, merged
 * today, and PRs in CI — or, once CI is quiet, the fixes that healed on their own.
 */
import { SlotMeter } from '@/components/fleet/SlotMeter';

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
}

function Stat({ label, value, children, testId, tone }: { label: string; value: React.ReactNode; children?: React.ReactNode; testId: string; tone?: 'accent' }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 px-4 py-3.5 md:px-6 md:py-5">
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">{label}</span>
      <span className={`font-mono text-[34px] font-semibold leading-none tracking-[-1px] md:text-[46px] ${tone === 'accent' ? 'text-accent-text' : 'text-text-primary'}`}>
        {value}
      </span>
      <span className="mt-1 flex min-h-4 min-w-0 items-center justify-between gap-2 truncate font-mono text-[11px] text-text-muted md:text-[12px]">{children}</span>
    </div>
  );
}

export function StatStrip(p: StatStripProps) {
  const ci = p.prsInCi.length > 0;
  return (
    <section
      data-testid="home-stat-strip"
      className="card mb-6 grid grid-cols-2 divide-border-default md:mb-8 md:grid-cols-[1.25fr_1fr_1fr_1fr] md:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border-default md:[&>*:nth-child(-n+2)]:border-b-0"
    >
      <Stat
        testId="stat-agents-live"
        label="Agents live"
        tone={p.live > 0 ? 'accent' : undefined}
        value={<>{p.live}<span className="ml-1 align-baseline text-[18px] font-normal tracking-normal text-text-muted md:text-[22px]">/{p.capacity}</span></>}
      >
        <SlotMeter live={p.live} max={p.capacity} size="lg" />
        <span className="hidden md:inline">{p.runners} runner{p.runners === 1 ? '' : 's'}</span>
      </Stat>
      <Stat testId="stat-needs-you" label="Needs you" value={p.needsYou}>
        <span className="truncate">{p.needsYouDetail ?? 'nothing waiting'}</span>
      </Stat>
      <Stat testId="stat-merged-today" label="Merged today" value={p.mergedToday}>
        <span className="truncate">{p.mergedDetail ?? '—'}</span>
      </Stat>
      {ci ? (
        <Stat testId="stat-prs-in-ci" label="PRs in CI" value={p.prsInCi.length}>
          <span className="truncate">{p.prsInCi.slice(0, 3).map(pr => `#${pr.prNumber}`).join(' ')}</span>
        </Stat>
      ) : (
        <Stat testId="stat-self-healed" label="Self-healed" value={p.selfHealed}>
          <span className="truncate">{p.selfHealed > 0 ? 'fixed without you today' : 'nothing broke today'}</span>
        </Stat>
      )}
    </section>
  );
}
