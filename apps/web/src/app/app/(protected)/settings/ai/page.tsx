import Link from 'next/link';
import SettingsPage from '../_components/SettingsPage';
import ModelFeatures from './ModelFeatures';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → AI → Chat and model features (was /app/settings#inference-spending). */
export default async function AiSettingsPage() {
  const { currentTeam, isTeamAdmin } = await loadSettingsContext();

  return (
    <SettingsPage
      title="Chat and model features"
      description={<>These call a model with your team&apos;s provider key. <Link href="/app/settings/models" className="underline hover:text-text-primary">Model tiers</Link> decide which model answers.</>}
    >
      {currentTeam ? (
        <ModelFeatures teamId={currentTeam.id} canManage={isTeamAdmin} />
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team to turn these on.</p>
      )}
    </SettingsPage>
  );
}
