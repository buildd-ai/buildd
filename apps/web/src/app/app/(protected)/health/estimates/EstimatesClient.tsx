import Link from 'next/link';
import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';
import { estimatesReadout } from './estimates-view';
import { FEATURES_SETTINGS_HREF } from './EstimatesOff';

/**
 * Health › Estimates with estimates on: how often a task finished within its
 * upper estimate, over how many. An owner/admin also gets the way to the switch.
 */
export function EstimatesClient({ readout, canManage }: { readout: TaskEstimateReadout; canManage: boolean }) {
  const view = estimatesReadout(readout);
  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6" data-testid="estimates-page">
      <h1 className="hidden md:block text-heading font-bold mb-4">Estimates</h1>
      <div className="py-3 space-y-1">
        <p className="text-title font-semibold text-text-primary" data-testid="estimates-lead">{view.lead}</p>
        {view.sample && <p className="text-body text-text-muted" data-testid="estimates-sample">{view.sample}</p>}
        {view.typical && <p className="text-body text-text-muted" data-testid="estimates-typical">{view.typical}</p>}
        {view.limitedHistory && (
          <p className="text-meta text-text-muted" data-testid="estimates-limited-history">{view.limitedHistory}</p>
        )}
      </div>
      {canManage && (
        <Link
          href={FEATURES_SETTINGS_HREF}
          className="inline-flex items-center min-h-11 md:min-h-0 text-meta text-accent-text hover:underline"
          data-testid="estimates-settings"
        >
          Manage in Settings › Features
        </Link>
      )}
    </div>
  );
}
