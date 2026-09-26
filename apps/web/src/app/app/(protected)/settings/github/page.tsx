import SettingsPage from '../_components/SettingsPage';
import GitHubSection from '../GitHubSection';
import VercelSection from '../VercelSection';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → Connections → GitHub and Vercel. */
export default async function GitHubSettingsPage() {
  const { teams } = await loadSettingsContext();
  return (
    <SettingsPage title="GitHub and Vercel">
      <GitHubSection />
      <VercelSection teams={teams.map((t) => ({ id: t.id, name: t.name }))} />
    </SettingsPage>
  );
}
