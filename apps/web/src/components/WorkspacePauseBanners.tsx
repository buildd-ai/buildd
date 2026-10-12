import Notice from '@/components/ui/Notice';
import { pauseUntilPhrase, type WorkspacePauseRow } from '@/lib/workspace-pause-view';

/**
 * Health › Runners: one banner per workspace whose new starts are paused. Read
 * only; the control is on the workspace's settings page (Where work runs),
 * which the banner links to.
 */
export default function WorkspacePauseBanners({ workspaces }: { workspaces: WorkspacePauseRow[] }) {
  const paused = workspaces.filter(w => w.pausedUntil);
  if (paused.length === 0) return null;
  return (
    <div className="mb-6 flex flex-col gap-3" data-testid="workspace-pause-panel">
      {paused.map(w => (
        <Notice
          key={w.id}
          tone="warn"
          title={`New starts paused in ${w.name} ${pauseUntilPhrase(w.pausedUntil!)}`}
          action={{ label: 'Settings', href: `/app/settings/workspace/${w.id}#pause-starts` }}
          data-testid="workspace-pause-banner"
        >
          Running work carries on.
        </Notice>
      ))}
    </div>
  );
}
