import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { isBillingEnforced } from '@buildd/core/entitlements';
import { effectiveKeyPolicy } from '@buildd/core/inference-key-policy';
import Chip from '@/components/ui/Chip';
import Section from '@/components/ui/Section';
import { roleHas } from '@/lib/permission-registry';
import { BILLING_TEAM_COLUMNS } from '@/lib/billing/team-billing-access';
import { teamSeatUsage } from '@/lib/billing/seats';
import { settingsReadOnly } from '@/lib/settings-nav';
import { DEFAULT_CHAT_DAILY_BUDGET_USD, DEFAULT_CHAT_USER_SHARE } from '@/lib/chat/limits';
import { loadSpendSummary, type SpendSummary } from '@/lib/spend-summary';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { billingView, PLAN_FEATURES, PLAN_LABELS } from './billing-view';
import { ManageBillingButton, SeatsForm, UpgradeButton } from './BillingActions';
import CapsForm from './CapsForm';
import { timeZoneLabel } from './timezone-label';
import { MySpend, PeopleSpend } from './SpendTables';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team → Billing and budgets: the team's plan, seats and the Stripe
 * portal, then your spend (Interactive vs Agent runs), everyone's for admins,
 * and the daily caps on interactive spend. Runner spend limits sit on each
 * runner token.
 *
 * While BILLING_ENFORCED is off the plan half is absent and the page is
 * Budgets (settingsNavFor names it the same way). Every plan change goes
 * through Stripe; the plan shown here moves when the webhook lands, not when
 * a button is pressed.
 */
export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const billing = isBillingEnforced();
  const title = billing ? 'Billing and budgets' : 'Budgets';
  const { user, currentTeam, perms } = await loadSettingsContext();
  const { checkout } = await searchParams;

  if (!currentTeam) {
    return (
      <SettingsPage title={title}>
        <p className="text-sm text-text-secondary">Join or create a team first.</p>
      </SettingsPage>
    );
  }

  const [teamRow, members, usage] = await Promise.all([
    db.query.teams.findFirst({
      where: eq(teams.id, currentTeam.id),
      columns: { ...BILLING_TEAM_COLUMNS, timezone: true, inferenceKeyPolicy: true, credentialPolicy: true },
    }).catch(() => null),
    db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, currentTeam.id),
      with: { user: { columns: { id: true, name: true, email: true } } },
    }).catch(() => [] as Array<{ userId: string; user: { name: string | null; email: string | null } | null }>),
    billing ? teamSeatUsage(currentTeam.id).catch(() => ({ members: 0, pending: 0 })) : null,
  ]);
  const keyPolicy = effectiveKeyPolicy(teamRow) ?? 'team';
  const timeZone = teamRow?.timezone || 'UTC';
  const spend: SpendSummary | null = await loadSpendSummary({
    teamId: currentTeam.id,
    userId: user.id,
    timeZone,
    now: new Date(),
    members: members.map((m) => ({ userId: m.userId, name: m.user?.name ?? null, email: m.user?.email ?? null })),
  }).catch(() => null);

  // manage_billing is locked to owner/admin; a personal team's user is its owner.
  const canManageBilling = roleHas(currentTeam.role, 'manage_billing', null) || currentTeam.slug === `personal-${user.id}`;

  return (
    <SettingsPage title={title} readOnly={settingsReadOnly('billing', perms) && !canManageBilling}>
      {billing && checkout === 'success' && (
        <p className="notice notice-ok text-sm" data-testid="billing-checkout-success">
          Payment received. Your plan updates here in a moment.
        </p>
      )}

      {billing && (teamRow && usage
        ? <PlanSections view={billingView(teamRow, usage)} teamId={currentTeam.id} canManage={canManageBilling} />
        : <p className="text-sm text-text-secondary">Could not load billing.</p>)}

      <Section
        title="Your spend"
        action={<span className="text-xs text-text-muted">{timeZoneLabel(timeZone)}</span>}
      >
        {spend ? <MySpend me={spend.me} /> : <p className="text-sm text-text-secondary">Could not load spend.</p>}
        <p className="mt-2 text-xs text-text-secondary">
          Spend in detail is in{' '}
          <Link href="/app/health/usage" className="underline hover:text-text-primary" data-testid="budgets-usage-link">Health › Usage</Link>.
        </p>
      </Section>

      {/* Kept here pending an owner decision on whether it moves to Health › Usage. */}
      {perms.view_team_usage && spend && spend.people.length > 1 && (
        <Section title="By person this month">
          <PeopleSpend people={spend.people} unattributed={spend.unattributedAgent} />
        </Section>
      )}

      <Section title="Interactive caps">
        <CapsForm
          teamId={currentTeam.id}
          canManage={perms.manage_team_settings}
          keyPolicy={keyPolicy}
          defaultTeamUsd={DEFAULT_CHAT_DAILY_BUDGET_USD}
          defaultUserShare={DEFAULT_CHAT_USER_SHARE}
        />
      </Section>
    </SettingsPage>
  );
}

/** The plan, seats and upgrades. Rendered only while billing is enforced. */
function PlanSections({ view, teamId, canManage }: {
  view: ReturnType<typeof billingView>;
  teamId: string;
  canManage: boolean;
}) {
  return (
    <>
      <section aria-labelledby="billing-plan-h" data-testid="billing-current-plan">
        <h2 id="billing-plan-h" className="section-label mb-3">Current plan</h2>
        <div className="border border-border-default bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-title font-semibold text-text-primary">{view.planLabel}</span>
            {view.status && <Chip tone={view.status.tone}>{view.status.label}</Chip>}
          </div>
          <p className="text-body text-text-secondary">{view.seatsLine}</p>
          <p className="text-meta text-text-muted">{PLAN_FEATURES[view.plan].join(' · ')}</p>
          {view.status?.label === 'payment failed' && (
            <p className="notice notice-err text-sm">The last payment failed. Update the card in Manage billing.</p>
          )}
          {canManage && view.hasCustomer && (
            <div className="pt-1">
              <ManageBillingButton teamId={teamId} primary={view.upgrades.length === 0} />
            </div>
          )}
        </div>
      </section>

      {canManage && view.plan === 'team' && view.subscribed && view.paidSeats !== null && (
        <section aria-labelledby="billing-seats-h">
          <h2 id="billing-seats-h" className="section-label mb-3">Members</h2>
          <SeatsForm teamId={teamId} paidSeats={view.paidSeats} used={view.used} />
        </section>
      )}

      {view.upgrades.length > 0 && (
        <section aria-labelledby="billing-plans-h">
          <h2 id="billing-plans-h" className="section-label mb-3">Plans</h2>
          <ul className="grid gap-3 md:grid-cols-2" data-testid="billing-plans">
            {view.upgrades.map((plan) => (
              <li key={plan} className="border border-border-default bg-card p-4 flex flex-col gap-3" data-testid={`billing-plan-${plan}`}>
                <span className="text-title font-semibold text-text-primary">{PLAN_LABELS[plan]}</span>
                <ul className="text-body text-text-secondary space-y-1 flex-1">
                  {PLAN_FEATURES[plan].map((f) => <li key={f}>{f}</li>)}
                </ul>
                {canManage && (
                  plan === 'pro' && view.proBlocked
                    ? <p className="text-meta text-text-muted">For one person. This team has more.</p>
                    : <UpgradeButton teamId={teamId} plan={plan} seats={plan === 'team' ? view.used : undefined} primary={plan === 'team'} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
