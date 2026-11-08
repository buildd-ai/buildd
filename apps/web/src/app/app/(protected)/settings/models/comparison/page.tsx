import Link from 'next/link';
import SettingsPage from '../../_components/SettingsPage';
import { loadSettingsContext } from '../../_lib/settings-context';
import { loadModelComparison, parseComparisonFilters } from '@/lib/model-comparison-query';
import { FilterSelect } from './FilterSelect';
import ModelComparisonView from './ModelComparisonView';
import { resolveComparisonQaData } from './qa-state';
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
 *
 * `?state=populated` (dev server only) renders sample attempts so the visual
 * audit can see the populated page — see ./qa-state.ts.
 */
export default async function ModelComparisonPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const qaData = resolveComparisonQaData(sp.state);
  const { currentTeam, workspaces } = await loadSettingsContext();
  const description = 'Model results on your work.';

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
  const data = qaData ?? (await loadModelComparison(picked.id, filters));

  return (
    <SettingsPage title="Compare models" description={description} wide>
      <Link href="/app/settings/models" className="text-sm text-text-secondary underline underline-offset-2 py-2 inline-block">Model settings</Link>
      <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="comparison-filters">
        {teamWorkspaces.length > 1 && (
          <FilterSelect name="workspace" label="Workspace" initial={picked.id} options={teamWorkspaces.map((w) => ({ value: w.id, label: w.name }))} />
        )}
        {FIELDS.map((f) => (
          <label key={f.name} className="text-xs text-text-muted flex flex-col gap-1">
            {f.label}
            <input name={f.name} defaultValue={one(sp[f.name]) ?? ''} placeholder={f.placeholder} className="min-h-11 border border-border bg-card px-2 text-sm text-text-primary" />
          </label>
        ))}
        <FilterSelect name="window" label="Period" initial={filters.window ?? '30d'} options={[
          { value: '24h', label: 'Last 24 hours' }, { value: '7d', label: 'Last 7 days' },
          { value: '30d', label: 'Last 30 days' }, { value: '90d', label: 'Last 90 days' },
        ]} />
        <div className="flex items-end">
          <button type="submit" className="btn min-h-11 w-full sm:w-auto">Apply</button>
        </div>
      </form>
      {!parsed.ok && <p className="text-sm text-text-muted">{parsed.error}. Showing the last 30 days.</p>}
      <ModelComparisonView data={data} />
    </SettingsPage>
  );
}
