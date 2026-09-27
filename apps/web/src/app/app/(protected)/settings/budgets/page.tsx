import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { isInferenceKeyPolicy } from '@buildd/core/inference-key-policy';
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
  const { user, currentTeam, isTeamAdmin } = await loadSettingsContext();

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
      columns: { timezone: true, inferenceKeyPolicy: true },
    }).catch(() => null),
    db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, currentTeam.id),
      with: { user: { columns: { id: true, name: true, email: true } } },
    }).catch(() => [] as Array<{ userId: string; user: { name: string | null; email: string | null } | null }>),
  ]);
  const keyPolicy = isInferenceKeyPolicy(teamRow?.inferenceKeyPolicy) ? teamRow.inferenceKeyPolicy : 'team';
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
      <section aria-labelledby="my-spend-h">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 id="my-spend-h" className="section-label">Your spend</h2>
          <span className="text-xs text-text-muted">{timeZoneLabel(timeZone)}</span>
        </div>
        {spend ? <MySpend me={spend.me} /> : <p className="text-sm text-text-secondary">Could not load spend.</p>}
      </section>

      {isTeamAdmin && spend && spend.people.length > 1 && (
        <section aria-labelledby="people-spend-h">
          <h2 id="people-spend-h" className="section-label mb-3">By person · this month</h2>
          <PeopleSpend people={spend.people} unattributed={spend.unattributedAgent} />
        </section>
      )}

      <section aria-labelledby="caps-h">
        <h2 id="caps-h" className="section-label mb-3">Interactive caps</h2>
        <CapsForm
          teamId={currentTeam.id}
          canManage={isTeamAdmin}
          keyPolicy={keyPolicy}
          defaultTeamUsd={DEFAULT_CHAT_DAILY_BUDGET_USD}
          defaultUserShare={DEFAULT_CHAT_USER_SHARE}
        />
      </section>
    </SettingsPage>
  );
}
