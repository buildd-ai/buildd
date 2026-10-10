import { hasTeamInferenceKey } from '@buildd/core/inference-keys';
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
import ModelFeatures from '../ai/ModelFeatures';
// Experiment: remove with apps/web/src/lib/chat-retro/ (see its REMOVAL.md).
import ChatRetroSection from '@/lib/chat-retro/ChatRetroSection';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Models: every team model concern on one page, in the order
 * you set it up. Keys (the team's, then one workspace's at a time; every way a
 * provider is connected: key, subscription and runner sign-in, in one row per
 * provider), Routing (gateway, decision model,
 * agent endpoint), Tiers (which model each tier runs, limits, upgrades) and
 * Features (where AI features run). Was /app/settings/providers and
 * /app/settings/ai; next.config redirects both here. Your own keys are
 * You › Keys (the old `?scope=mine` redirects there).
 *
 * Every section is a client component that loads its own data, so one failed
 * read blanks that section, not the page. Each control follows the permission
 * its API enforces; this only decides what renders.
 */
export default async function ModelsSettingsPage() {
  const { currentTeam, currentTeamId, perms, permsByTeam, workspaces } = await loadSettingsContext();

  if (!currentTeam) {
    return (
      <SettingsPage title="Models" description={PROVIDERS_DESCRIPTION} wide>
        <p className="text-sm text-text-secondary">Join or create a team to connect a model provider.</p>
      </SettingsPage>
    );
  }

  const teamId = currentTeam.id;
  const teamWorkspaces = workspaces.filter((w) => w.teamId === teamId);
  const hasTeamKey = await hasTeamInferenceKey(teamId).catch(() => false);

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

      <Section title="Features" id="features" className="scroll-mt-20">
        {/* Old /app/settings#inference-spending links. */}
        <span id="inference-spending" aria-hidden="true" />
        <ModelFeatures teamId={teamId} canManage={perms.manage_team_settings} hasTeamKey={hasTeamKey} />
        {/* Its settings and lessons are admin-only reads: members have no values to see. */}
        {perms.manage_chat_retro && <ChatRetroSection teamId={teamId} isAdmin />}
      </Section>
    </SettingsPage>
  );
}
