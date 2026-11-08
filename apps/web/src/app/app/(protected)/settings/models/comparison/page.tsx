import Link from 'next/link';
import SettingsPage from '../../_components/SettingsPage';
import { loadSettingsContext } from '../../_lib/settings-context';
import { loadModelComparison, parseComparisonFilters } from '@/lib/model-comparison-query';
import ModelComparisonView from './ModelComparisonView';
import { resolveComparisonWorkspace } from './workspace-pick';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const FIELDS: Array<{ name: string; label: string; placeholder: string }> = [
  { name: 'model', label: 'Model', placeholder: 'sonnet' },
  { name: 'harness', label: 'Harness', placeholder: 'version or backend' },
  { name: 'hardware', label: 'Hardware', placeholder: 'GPU or os/arch' },
  { name: 'taskType', label: 'Task type', placeholder: 'engineering' },
];

/**
 * Settings › Models › Compare: how each model and setup has done on this
 * workspace's real work. Read-only: it never changes which model runs. Only
 * workspaces the viewer can reach are offered; anything else falls back to the
 * first one they can.
 */
export default async function ModelComparisonPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { currentTeam, workspaces } = await loadSettingsContext();
  const description = 'How each model has done on your own work.';

  const teamWorkspaces = currentTeam ? workspaces.filter((w) => w.teamId === currentTeam.id) : [];
  const picked = resolveComparisonWorkspace(teamWorkspaces, one(sp.workspace));
  if (!currentTeam || !picked) {
    return (
      <SettingsPage title="Compare models" description={description} wide>
        <p className="text-sm text-text-secondary" data-testid="comparison-no-workspace">Join a team with a workspace to compare models.</p>
      </SettingsPage>
    );
  }

  const parsed = parseComparisonFilters((k) => one(sp[k]));
  const filters = parsed.ok ? parsed.filters : { window: '30d' as const };
  const data = await loadModelComparison(picked.id, filters);

  return (
    <SettingsPage title="Compare models" description={description} wide>
      <Link href="/app/settings/models" className="text-sm text-text-secondary underline underline-offset-2 py-2 inline-block">Model settings</Link>
      <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="comparison-filters">
        {teamWorkspaces.length > 1 && (
          <label className="text-xs text-text-muted flex flex-col gap-1">
            Workspace
            <select name="workspace" defaultValue={picked.id} className="min-h-11 border border-border bg-card px-2 text-sm text-text-primary">
              {teamWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        )}
        {FIELDS.map((f) => (
          <label key={f.name} className="text-xs text-text-muted flex flex-col gap-1">
            {f.label}
            <input name={f.name} defaultValue={one(sp[f.name]) ?? ''} placeholder={f.placeholder} className="min-h-11 border border-border bg-card px-2 text-sm text-text-primary" />
          </label>
        ))}
        <label className="text-xs text-text-muted flex flex-col gap-1">
          Period
          <select name="window" defaultValue={filters.window ?? '30d'} className="min-h-11 border border-border bg-card px-2 text-sm text-text-primary">
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn min-h-11 w-full sm:w-auto">Apply</button>
        </div>
      </form>
      {!parsed.ok && <p className="text-sm text-text-muted">{parsed.error}. Showing the last 30 days.</p>}
      <ModelComparisonView data={data} />
    </SettingsPage>
  );
}
