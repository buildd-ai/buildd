/**
 * Home banner when the team's hosted runner allowance is at 80% (a heads-up)
 * or used (new cloud runs wait). Nothing below that, and nothing for a team
 * without an allowance. Not an error: neutral notice, one link to Billing and budgets,
 * where the team's hosted runner month is.
 */
import Link from 'next/link';
import Chip from '@/components/ui/Chip';

export function HostedRunnerBanner({ level, text }: { level: 'warn' | 'used'; text: string }) {
  return (
    <div
      data-testid="hosted-runner-banner"
      data-level={level}
      role="status"
      className="mb-5 flex flex-col gap-2 border border-border-default bg-surface-2 p-3 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Chip tone={level === 'used' ? 'warning' : 'info'}>{level === 'used' ? 'Used' : '80%'}</Chip>
        <p className="min-w-0 text-body text-text-primary">{text}</p>
      </div>
      <Link href="/app/settings/billing" className="btn btn-quiet min-h-11 shrink-0 md:min-h-0">
        See usage
      </Link>
    </div>
  );
}
