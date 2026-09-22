/**
 * Client-safe shape of the /app/health Experiments section. Kept apart from
 * health-experiments.ts (which touches the db) so the client component never
 * pulls a server module into its bundle.
 */
import type { Experiment } from '@buildd/shared';
import type { ExperimentReadout } from '@buildd/core/experiment-readout';

export interface HealthExperimentItem {
  experiment: Experiment;
  /** Null for drafts (nothing drawn yet) and when the readout query failed. */
  readout: ExperimentReadout | null;
}

export interface HealthExperiments {
  /** Viewer is team admin|owner: sees admins-only rows and the controls. */
  canManage: boolean;
  items: HealthExperimentItem[];
}

/** The section is hidden for a viewer with nothing to see and nothing to do. */
export function shouldShowExperiments(data: HealthExperiments | null): data is HealthExperiments {
  if (!data) return false;
  return data.canManage || data.items.length > 0;
}
