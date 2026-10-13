import type { RunnerModelAuthSource } from '@buildd/shared';

export interface ModelAuthLabel {
  text: string;
  /** A command the reader should run, rendered as code after `text`. */
  command?: string;
  /** Render with the warning hue: the runner cannot reach a model. */
  warning: boolean;
}

const NOT_REPORTED: ModelAuthLabel = { text: 'Model login: not reported', warning: false };

/**
 * The words a runner row shows for the model login its runner reported on
 * its heartbeat (docs/specs/runner-model-auth-source.md). Null is an older
 * runner that never sends the field, which is not the same as `none`.
 */
export function modelAuthLabel(source: RunnerModelAuthSource | null | undefined): ModelAuthLabel {
  switch (source) {
    case 'machine_token': return { text: 'Uses a Claude token set on this machine', warning: false };
    case 'machine_login': return { text: "Uses this machine's Claude login", warning: false };
    case 'api_key': return { text: 'Uses an API key (billed per token)', warning: false };
    case 'none': return { text: 'No model login on this machine. Run', command: 'claude login', warning: true };
    default: return NOT_REPORTED;
  }
}
