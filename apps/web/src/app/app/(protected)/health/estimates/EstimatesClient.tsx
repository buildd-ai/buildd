import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';
import { estimatesReadout } from './estimates-view';

/**
 * Health › Estimates with estimates on: how often a task finished within its
 * upper estimate, the target, typical ratio and sample size.
 */
export function EstimatesClient({ readout }: { readout: TaskEstimateReadout; canManage?: boolean }) {
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

    </div>
  );
}
