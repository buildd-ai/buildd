/**
 * Which calls may spend a team's provider key (a pay-per-token API key; runners
 * never use one, they work on their own subscription or seat).
 *
 * Three kinds of call site, each with its own rule:
 *
 * - **interactive** (`chat`): always on. It runs whenever a key resolves; there
 *   is no switch (`teams.chatDisabled` is deprecated and unread).
 * - **built_in** decision calls (task classification, the task category shadow
 *   check): low cost, no toggle. They run whenever a key resolves.
 * - **server_feature** (goal grading, visual QA judgment, mission summaries):
 *   each has a runner path. The default follows the team's billing model: a
 *   pay-per-token team key → server-side; subscription only → runner. An admin
 *   may override per feature (`teams.inferenceFeatureModes`).
 *
 * This is a mask above key resolution, not part of it: "allowed" here still
 * needs a key to resolve, and a call site whose key does not resolve takes its
 * runner path (or does nothing, for built-ins). So the default needs no stored
 * state: a team with a key gets the server-side path, one without gets the
 * runner, and adding or removing the key moves every default with it.
 */

/** Every inference call site in the platform, named. */
export type InferenceCapability =
  | 'criteria_grading'
  | 'visual_qa'
  | 'task_classification'
  | 'mission_summary'
  | 'heartbeat_triage'
  | 'task_category'
  | 'chat';

export type CapabilityKind = 'interactive' | 'built_in' | 'server_feature';

export interface CapabilityDescriptor {
  id: InferenceCapability;
  kind: CapabilityKind;
  label: string;
  /** One line, for the settings page. */
  description: string;
  /** Rough per-call cost. */
  costHint: string;
}

export const INFERENCE_CAPABILITIES: Record<InferenceCapability, CapabilityDescriptor> = {
  criteria_grading: {
    id: 'criteria_grading',
    kind: 'server_feature',
    label: 'Goal grading',
    description: 'Grades a mission\'s written goals against its tasks and artifacts.',
    costHint: '~$0.001 per check',
  },
  visual_qa: {
    id: 'visual_qa',
    kind: 'server_feature',
    label: 'Visual QA judgment',
    description: 'Judges the screenshots the visual-auditor role captured on a runner. Server-side is faster.',
    costHint: '~$0.01 per page',
  },
  mission_summary: {
    id: 'mission_summary',
    kind: 'server_feature',
    label: 'Mission summaries',
    description: 'Answers questions about a mission and condenses long note threads.',
    costHint: '~$0.005 per request',
  },
  heartbeat_triage: {
    id: 'heartbeat_triage',
    kind: 'server_feature',
    label: 'Heartbeat triage',
    description: 'Checks whether a mission check-in needs the organizer before starting a runner.',
    costHint: '~$0.0001 per check-in (OpenRouter key)',
  },
  task_classification: {
    id: 'task_classification',
    kind: 'built_in',
    label: 'Task classification',
    description: 'Tags a new task with its kind and complexity.',
    costHint: '~$0.001 per task',
  },
  task_category: {
    id: 'task_category',
    kind: 'built_in',
    label: 'Task categories',
    description: 'A decision model picks each task\'s category when it is confident. Never changes a category you set, or a review task.',
    costHint: '~$0.00002 per task',
  },
  chat: {
    id: 'chat',
    kind: 'interactive',
    label: 'Interactive',
    description: 'Chat with your buildd agent, on the server.',
    costHint: '~$0.005–0.05 per turn',
  },
};

export const ALL_INFERENCE_CAPABILITIES = Object.keys(INFERENCE_CAPABILITIES) as InferenceCapability[];

/** The features with a runner path. Overrides may name any of them. */
export const SERVER_FEATURES = ['criteria_grading', 'visual_qa', 'mission_summary', 'heartbeat_triage'] as const;
export type ServerFeature = typeof SERVER_FEATURES[number];

/**
 * The server-side features with a call site today, which is all the AI page
 * shows: a switch for a feature that never runs is a switch that lies. Visual
 * QA judgment and mission summaries have ids (and stored overrides survive) but
 * nothing calls them yet; add one here in the PR that wires its call site.
 */
export const LIVE_SERVER_FEATURES: readonly ServerFeature[] = ['criteria_grading', 'heartbeat_triage'];

/** Where a server-side feature runs. */
export type FeatureMode = 'server' | 'runner';
/** `teams.inferenceFeatureModes`: overrides only. An absent feature follows the default. */
export type FeatureModes = Partial<Record<ServerFeature, FeatureMode>>;

/** True when `value` names a capability this build knows about. */
export function isInferenceCapability(value: unknown): value is InferenceCapability {
  return typeof value === 'string' && value in INFERENCE_CAPABILITIES;
}

export function isServerFeature(value: unknown): value is ServerFeature {
  return typeof value === 'string' && (SERVER_FEATURES as readonly string[]).includes(value);
}

function storedMode(modes: unknown, feature: ServerFeature): FeatureMode | null {
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return null;
  const v = (modes as Record<string, unknown>)[feature];
  return v === 'server' || v === 'runner' ? v : null;
}

/** The team columns the gate reads. */
export interface InferenceGate {
  featureModes?: unknown;
}

/**
 * May this call site spend the team's key? A missing team row fails closed.
 * Unknown or malformed stored values read as "no override".
 */
export function isInferenceAllowed(capability: InferenceCapability, gate: InferenceGate | null | undefined): boolean {
  if (!gate) return false;
  const d = INFERENCE_CAPABILITIES[capability];
  if (!d) return false;
  if (d.kind === 'built_in' || d.kind === 'interactive') return true;
  return storedMode(gate.featureModes, capability as ServerFeature) !== 'runner';
}

/**
 * Where a server-side feature runs, for the settings page. `hasTeamKey` is the
 * billing model: a pay-per-token key the team's own work can spend.
 */
export function resolveFeatureMode(
  feature: ServerFeature,
  modes: unknown,
  hasTeamKey: boolean,
): { mode: FeatureMode; source: 'default' | 'override'; needsKey: boolean } {
  const o = storedMode(modes, feature);
  if (o) return { mode: o, source: 'override', needsKey: o === 'server' && !hasTeamKey };
  return { mode: hasTeamKey ? 'server' : 'runner', source: 'default', needsKey: false };
}

/**
 * Normalize an operator-supplied override map: known features, `server` or
 * `runner` only; `default` (or anything else) clears the override. Null when
 * nothing is overridden, so the column has one "all defaults" form.
 */
export function normalizeFeatureModes(input: unknown): FeatureModes | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: FeatureModes = {};
  for (const f of SERVER_FEATURES) {
    const m = storedMode(input, f);
    if (m) out[f] = m;
  }
  return Object.keys(out).length > 0 ? out : null;
}
