import { displayWorkspaceName } from '@buildd/shared';
import WorkspacePauseBanners from '@/components/WorkspacePauseBanners';
import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/runners`: Runners & capacity: slots in use, runners, budget and
 * credentials. Reads `?workspace=`. The active team's workspaces whose new
 * starts are paused come with the page's own workspace read. Health only
 * shows a pause; pausing and resuming live on each workspace's settings page
 * (Where work runs), under manage_workspace_settings.
 */
export default async function HealthRunnersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  return renderHealthPage('runners', searchParams, ({ pausedWorkspaces }) => (
    <WorkspacePauseBanners workspaces={pausedWorkspaces.map(w => ({ ...w, name: displayWorkspaceName(w.name) }))} />
  ));
}
