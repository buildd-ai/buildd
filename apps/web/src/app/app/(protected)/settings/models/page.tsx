import Section from '@/components/ui/Section';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { settingsReadOnly } from '@/lib/settings-nav';
import { isPlatformOperatorCaller } from '@/lib/admin/platform-operator-caller';
import ModelProvidersClient from '../providers/ModelProvidersClient';
import { PROVIDERS_DESCRIPTION } from '../providers/provider-copy';
import ModelTiersClient from './ModelTiersClient';
import TierLimitSection from './TierLimitSection';
import ChatTierPolicySection from './ChatTierPolicySection';
import ModelUpgradePolicySection from './ModelUpgradePolicySection';
import { resolveModelsQaDecisions } from './qa-state';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Models: every team model concern on one page, in the order
 * you set it up. Keys (the team's API keys, gateway and agent endpoint, one row
 * per provider), Used for (which provider serves each surface, the decision
 * model, provider routing) and Tiers (which model each tier runs, limits, upgrades).
 * Goal grading has no control: Auto is the behaviour. Was /app/settings/providers and
 * /app/settings/ai; next.config redirects both here. Your own keys are
 * You › Keys (the old `?scope=mine` redirects there).
 *
 * Every section is a client component that loads its own data, so one failed
 * read blanks that section, not the page. Each control follows the permission
 * its API enforces; this only decides what renders. A team admin picks each
 * tier's primary model; traffic pools and the decision model are platform
 * operator controls (lib/admin/platform-operator-caller.ts) and render for an operator only.
 * Your own maximum is You › Keys.
 *
 * `?state=decisions` (dev server only) shows sample decision overrides and
 * switch lines in the operator's Decisions row — see ./qa-state.ts.
 */
export default async function ModelsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const qaDecisions = resolveModelsQaDecisions((await searchParams).state);
  const { user, currentTeam, perms, workspaces } = await loadSettingsContext();
  const operator = await isPlatformOperatorCaller({ user });

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
      {/* Old #features and /app/settings#inference-spending links land on the page top. */}
      <span id="features" aria-hidden="true" />
      <span id="inference-spending" aria-hidden="true" />
      <ModelProvidersClient
        teamId={teamId}
        isAdmin={perms.manage_inference_providers}
        operator={operator}
        qaDecisions={qaDecisions}
        workspaces={teamWorkspaces.map((w) => ({ id: w.id, name: w.name }))}
      />

      <Section title="Tiers" id="tiers" className="scroll-mt-20">
        <ModelTiersClient teamId={teamId} teamName={currentTeam.name ?? null} isAdmin={perms.manage_model_tiers} operator={operator} />
        <TierLimitSection teamId={teamId} isAdmin={perms.manage_model_tiers} />
        <ChatTierPolicySection teamId={teamId} isAdmin={perms.manage_model_tiers} />
        <ModelUpgradePolicySection teamId={teamId} isAdmin={perms.manage_model_tiers} />
      </Section>
    </SettingsPage>
  );
}
