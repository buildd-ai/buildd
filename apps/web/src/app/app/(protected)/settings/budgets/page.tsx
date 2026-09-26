import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import ChatBudgetsForm from './ChatBudgetsForm';
import { DEFAULT_CHAT_DAILY_BUDGET_USD, DEFAULT_CHAT_USER_SHARE } from '@/lib/chat/limits';

export const dynamic = 'force-dynamic';

/** Settings → Team → Budgets. Chat caps; runner spend limits sit on each runner token. */
export default async function BudgetsSettingsPage() {
  const { currentTeam, isTeamAdmin } = await loadSettingsContext();

  return (
    <SettingsPage
      title="Budgets"
      description={currentTeam
        ? `Daily chat spend caps for ${currentTeam.name}. Runners bill their own subscription or API key, so these caps only cover chat.`
        : undefined}
    >
      {currentTeam ? (
        <section aria-labelledby="chat-budgets-h">
          <h2 id="chat-budgets-h" className="section-label mb-3">Chat</h2>
          <ChatBudgetsForm
            teamId={currentTeam.id}
            canManage={isTeamAdmin}
            defaultTeamUsd={DEFAULT_CHAT_DAILY_BUDGET_USD}
            defaultUserShare={DEFAULT_CHAT_USER_SHARE}
          />
        </section>
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team to set budgets.</p>
      )}
    </SettingsPage>
  );
}
