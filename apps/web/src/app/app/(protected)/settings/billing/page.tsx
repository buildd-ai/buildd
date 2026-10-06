import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { isBillingEnforced } from '@buildd/core/entitlements';
import Chip from '@/components/ui/Chip';
import { roleHas } from '@/lib/permission-registry';
import { BILLING_TEAM_COLUMNS } from '@/lib/billing/team-billing-access';
import { teamSeatUsage } from '@/lib/billing/seats';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { billingView, PLAN_FEATURES, PLAN_LABELS } from './billing-view';
import { ManageBillingButton, SeatsForm, UpgradeButton } from './BillingActions';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team → Billing: the team's plan, upgrade buttons, seats and the
 * Stripe portal. Does not exist while BILLING_ENFORCED is off (404, and the nav
 * omits it). Every change goes through Stripe; the plan shown here moves when
 * the webhook lands, not when a button is pressed.
 */
export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  if (!isBillingEnforced()) notFound();

  const { user, currentTeam } = await loadSettingsContext();
  const { checkout } = await searchParams;

  if (!currentTeam) {
    return (
      <SettingsPage title="Billing">
        <p className="text-sm text-text-secondary">Join or create a team first.</p>
      </SettingsPage>
    );
  }

  const [teamRow, usage] = await Promise.all([
    db.query.teams.findFirst({ where: eq(teams.id, currentTeam.id), columns: BILLING_TEAM_COLUMNS }).catch(() => null),
    teamSeatUsage(currentTeam.id).catch(() => ({ members: 0, pending: 0 })),
  ]);
  if (!teamRow) {
    return (
      <SettingsPage title="Billing">
        <p className="text-sm text-text-secondary">Could not load billing.</p>
      </SettingsPage>
    );
  }

  const view = billingView(teamRow, usage);
  // manage_billing is locked to owner/admin; a personal team's user is its owner.
  const canManage = roleHas(currentTeam.role, 'manage_billing', null) || currentTeam.slug === `personal-${user.id}`;

  return (
    <SettingsPage title="Billing">
      {checkout === 'success' && (
        <p className="notice notice-ok text-sm" data-testid="billing-checkout-success">
          Payment received. Your plan updates here in a moment.
        </p>
      )}

      <section aria-labelledby="billing-plan-h" data-testid="billing-current-plan">
        <h2 id="billing-plan-h" className="section-label mb-3">Current plan</h2>
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-title font-semibold text-text-primary">{view.planLabel}</span>
            {view.status && <Chip tone={view.status.tone}>{view.status.label}</Chip>}
          </div>
          <p className="text-body text-text-secondary">{view.seatsLine}</p>
          {view.status?.label === 'payment failed' && (
            <p className="notice notice-err text-sm">The last payment failed. Update the card in Manage billing.</p>
          )}
          {canManage && view.hasCustomer && (
            <div className="pt-1">
              <ManageBillingButton teamId={currentTeam.id} primary={view.upgrades.length === 0} />
            </div>
          )}
        </div>
      </section>

      {canManage && view.plan === 'team' && view.subscribed && view.paidSeats !== null && (
        <section aria-labelledby="billing-seats-h">
          <h2 id="billing-seats-h" className="section-label mb-3">Seats</h2>
          <SeatsForm teamId={currentTeam.id} paidSeats={view.paidSeats} used={view.used} />
        </section>
      )}

      {view.upgrades.length > 0 && (
        <section aria-labelledby="billing-plans-h">
          <h2 id="billing-plans-h" className="section-label mb-3">Plans</h2>
          <ul className="grid gap-3 md:grid-cols-3" data-testid="billing-plans">
            {(['free', 'pro', 'team'] as const).map((plan) => {
              const current = plan === view.plan;
              const upgrade = view.upgrades.includes(plan as 'pro' | 'team') && plan !== 'free';
              return (
                <li key={plan} className={`p-4 flex flex-col gap-3 ${current ? 'card' : 'border border-border-default bg-card'}`} data-testid={`billing-plan-${plan}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-title font-semibold text-text-primary">{PLAN_LABELS[plan]}</span>
                    {current && <Chip tone="muted" dot={false}>current</Chip>}
                  </div>
                  <ul className="text-body text-text-secondary space-y-1 flex-1">
                    {PLAN_FEATURES[plan].map((f) => <li key={f}>{f}</li>)}
                  </ul>
                  {upgrade && canManage && (
                    plan === 'pro' && view.proBlocked
                      ? <p className="text-meta text-text-muted">For one person. This team has more.</p>
                      : <UpgradeButton teamId={currentTeam.id} plan={plan as 'pro' | 'team'} seats={plan === 'team' ? view.used : undefined} primary={plan === 'team'} />
                  )}
                </li>
              );
            })}
          </ul>
          {!canManage && (
            <p className="text-meta text-text-muted mt-3">Only team owners and admins can change the plan.</p>
          )}
        </section>
      )}
    </SettingsPage>
  );
}
