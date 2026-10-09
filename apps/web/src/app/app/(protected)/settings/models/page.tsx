import { hasTeamInferenceKey } from '@buildd/core/inference-keys';
import Section from '@/components/ui/Section';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { teamIdsHolding } from '../_lib/settings-permissions';
import ModelProvidersClient from '../providers/ModelProvidersClient';
import { PROVIDERS_DESCRIPTION } from '../providers/provider-copy';
import AgentBackendsSection from '../AgentBackendsSection';
import ModelTiersClient from './ModelTiersClient';
import TierLimitSection from './TierLimitSection';
import ChatTierPolicySection from './ChatTierPolicySection';
import ModelUpgradePolicySection from './ModelUpgradePolicySection';
import ModelFeatures from '../ai/ModelFeatures';
// Experiment: remove with apps/web/src/lib/chat-retro/ (see its REMOVAL.md).
import ChatRetroSection from '@/lib/chat-retro/ChatRetroSection';

export const dynamic = 'force-dynamic';

/**
 * Settings → Models: every model concern on one page, in the order you set it
 * up. Keys (provider keys at team, workspace or personal scope), Runner
 * sign-ins (what agent runs log in with), Routing (gateway, decision model,
 * agent endpoint), Tiers (which model each tier runs, limits, upgrades) and
 * Features (where AI features run). Was /app/settings/providers and
 * /app/settings/ai; next.config redirects both here.
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
    <SettingsPage title="Models" description={PROVIDERS_DESCRIPTION} wide>
      <ModelProvidersClient
        teamId={teamId}
        isAdmin={perms.manage_inference_providers}
        workspaces={teamWorkspaces.map((w) => ({ id: w.id, name: w.name }))}
        between={
          <Section title="Runner sign-ins" id="sign-ins" className="scroll-mt-20">
            {/* Old links: /app/settings/runners#agent-backends and /app/settings#agent-backends. */}
            <span id="agent-backends" aria-hidden="true" />
            {teamWorkspaces.length > 0 ? (
              <div data-testid="models-sign-ins" className="border-y border-border-default divide-y divide-border-default">
                <AgentBackendsSection
                  workspaces={workspaces}
                  currentTeamId={currentTeamId}
                  manageableTeamIds={teamIdsHolding(permsByTeam, 'manage_team_credentials')}
                  canManage={perms.manage_team_credentials}
                  canManageRouting={perms.manage_team_settings}
                />
              </div>
            ) : (
              <p className="text-sm text-text-muted">Add a workspace to connect a runner sign-in.</p>
            )}
          </Section>
        }
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
        <ChatRetroSection teamId={teamId} isAdmin={perms.manage_chat_retro} />
      </Section>
    </SettingsPage>
  );
}
