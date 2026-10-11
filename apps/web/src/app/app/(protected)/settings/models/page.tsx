import Section from '@/components/ui/Section';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { teamIdsHolding } from '../_lib/settings-permissions';
import { settingsReadOnly } from '@/lib/settings-nav';
import ModelProvidersClient from '../providers/ModelProvidersClient';
import { PROVIDERS_DESCRIPTION } from '../providers/provider-copy';
import ModelTiersClient from './ModelTiersClient';
import TierLimitSection from './TierLimitSection';
import ChatTierPolicySection from './ChatTierPolicySection';
import ModelUpgradePolicySection from './ModelUpgradePolicySection';
import { isPlatformOperator } from '@/lib/platform-operator';
import DecisionFeatures from '../ai/DecisionFeatures';
// Experiment: remove with apps/web/src/lib/chat-retro/ (see its REMOVAL.md).
import ChatRetroSection from '@/lib/chat-retro/ChatRetroSection';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Models: every team model concern on one page, in the order
 * you set it up. Keys (the team's, then one workspace's at a time; every way a
 * provider is connected: key, subscription and runner sign-in, in one row per
 * provider), Routing (gateway, decision model,
 * agent endpoint) and Tiers (which model each tier runs, limits, upgrades).
 * Features (opt-in decision features, chat session retros) moved to the admin
 * app; only the platform owner still sees it here. Goal grading has no control:
 * Auto is the behaviour. Was /app/settings/providers and
 * /app/settings/ai; next.config redirects both here. Your own keys are
 * You › Keys (the old `?scope=mine` redirects there).
 *
 * Every section is a client component that loads its own data, so one failed
 * read blanks that section, not the page. Each control follows the permission
 * its API enforces; this only decides what renders.
 */
export default async function ModelsSettingsPage() {
  const { user, currentTeam, currentTeamId, perms, permsByTeam, workspaces } = await loadSettingsContext();
  const showOperatorFeatures = isPlatformOperator(user);

  if (!currentTeam) {
    return (
      <SettingsPage title="Models" description={PROVIDERS_DESCRIPTION} wide>
        <p className="text-sm text-text-secondary">Join or create a team to connect a model provider.</p>
      </SettingsPage>
    );
  }

  const teamId = currentTeam.id;
  const teamWorkspaces = workspaces.filter((w) => w.teamId === teamId);

  return (
    <SettingsPage title="Models" description={PROVIDERS_DESCRIPTION} wide readOnly={settingsReadOnly('models', perms)}>
      <ModelProvidersClient
        teamId={teamId}
        isAdmin={perms.manage_inference_providers}
        workspaces={teamWorkspaces.map((w) => ({ id: w.id, name: w.name }))}
        signIns={{
          workspaces,
          currentTeamId,
          manageableTeamIds: teamIdsHolding(permsByTeam, 'manage_team_credentials'),
          canManage: perms.manage_team_credentials,
          canManageRouting: perms.manage_team_settings,
        }}
      />

      <Section title="Tiers" id="tiers" className="scroll-mt-20">
        <ModelTiersClient teamId={teamId} teamName={currentTeam.name ?? null} isAdmin={perms.manage_model_tiers} />
        <TierLimitSection teamId={teamId} isAdmin={perms.manage_model_tiers} />
        <ChatTierPolicySection teamId={teamId} isAdmin={perms.manage_model_tiers} />
        <ModelUpgradePolicySection teamId={teamId} isAdmin={perms.manage_model_tiers} />
      </Section>

      {showOperatorFeatures && (
        <Section title="Features" id="features" className="scroll-mt-20">
          {/* Old /app/settings#inference-spending links. */}
          <span id="inference-spending" aria-hidden="true" />
          <DecisionFeatures teamId={teamId} canManage={perms.manage_team_settings} />
          {perms.manage_chat_retro && <ChatRetroSection teamId={teamId} isAdmin />}
        </Section>
      )}
    </SettingsPage>
  );
}
