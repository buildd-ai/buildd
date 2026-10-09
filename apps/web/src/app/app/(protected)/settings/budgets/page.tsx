import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { effectiveKeyPolicy } from '@buildd/core/inference-key-policy';
import Link from 'next/link';
import Section from '@/components/ui/Section';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import CapsForm from './CapsForm';
import { timeZoneLabel } from './timezone-label';
import { MySpend, PeopleSpend } from './SpendTables';
import { DEFAULT_CHAT_DAILY_BUDGET_USD, DEFAULT_CHAT_USER_SHARE } from '@/lib/chat/limits';
import { loadSpendSummary, type SpendSummary } from '@/lib/spend-summary';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team → Budgets. Your spend (Interactive vs Agent runs), everyone's
 * for admins, and the daily caps on interactive spend. Runner spend limits sit
 * on each runner token.
 */
export default async function BudgetsSettingsPage() {
  const { user, currentTeam, perms } = await loadSettingsContext();

  if (!currentTeam) {
    return (
      <SettingsPage title="Budgets">
        <p className="text-sm text-text-secondary">Join or create a team first.</p>
      </SettingsPage>
    );
  }

  const [teamRow, members] = await Promise.all([
    db.query.teams.findFirst({
      where: eq(teams.id, currentTeam.id),
      columns: { timezone: true, inferenceKeyPolicy: true, credentialPolicy: true },
    }).catch(() => null),
    db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, currentTeam.id),
      with: { user: { columns: { id: true, name: true, email: true } } },
    }).catch(() => [] as Array<{ userId: string; user: { name: string | null; email: string | null } | null }>),
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

  return (
    <SettingsPage title="Budgets">
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
