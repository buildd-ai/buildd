/**
 * What the Plan page draws once its data is loaded (or failed to load), apart
 * from where the data comes from, so `?state=plan-*` in the dev fixtures renders
 * the same markup the page does. Server-safe: no hooks, no data access.
 */
import Link from 'next/link';
import { planAxis, planLede, planMissions, type PlanMissionInput, type ReleasePlan } from '@/lib/mission-plan';
import MissionPlanChart from './MissionPlanChart';

export function PlanShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-7 md:px-10 pt-6 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 data-testid="plan-headline" className="text-heading font-semibold text-text-primary">Plan</h1>
        <Link href="/app/missions" className="text-meta text-text-muted hover:text-text-secondary">‹ Missions</Link>
      </div>
      {children}
    </div>
  );
}

export function PlanOff() {
  return (
    <p data-testid="plan-off" className="text-body text-text-secondary">
      Plan needs task estimates, which are off for this team. Turn them on in{' '}
      <Link href="/app/settings/team" data-testid="plan-off-cta" className="underline hover:text-text-primary">team settings</Link>{' '}
      and finish dates will show here.
    </p>
  );
}

export function PlanError() {
  return (
    <p data-testid="plan-error" role="alert" className="text-body text-text-secondary">
      Plan could not be loaded. Reload to try again; your missions are unaffected.
    </p>
  );
}

export function PlanReady({ inputs, plans, now }: { inputs: readonly PlanMissionInput[]; plans: ReadonlyMap<string, ReleasePlan>; now: number }) {
  const rows = planMissions(inputs, now, plans);
  const lede = planLede(rows, plans, now);
  const cuts = [...plans.values()].flatMap(p => (p.mode === 'cuts' ? p.cuts : [])).filter(c => c >= now);
  const axis = planAxis(rows, cuts, now);
  const visibleCuts = cuts.filter(c => c <= axis.to);
  return (
    <>
      <p data-testid="plan-lede" className="font-voice text-[22px] leading-snug text-text-primary max-w-prose">{lede.headline}</p>
      {lede.detail && <p data-testid="plan-detail" className="mt-1 text-body text-text-secondary max-w-prose">{lede.detail}</p>}
      <div className="mt-6">
        {rows.length === 0 ? null : <MissionPlanChart rows={rows} axis={axis} cuts={visibleCuts} now={now} />}
      </div>
    </>
  );
}
