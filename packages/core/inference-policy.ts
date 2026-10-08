/**
 * Which calls may spend a team's provider key (a pay-per-token API key; runners
 * never use one, they work on their own subscription or seat).
 *
 * Four kinds of call site, each with its own rule:
 *
 * - **interactive** (`chat`): always on. It runs whenever a key resolves; there
 *   is no switch (`teams.chatDisabled` is deprecated and unread).
 * - **built_in** decision calls (task classification, the task category shadow
 *   check): low cost, no toggle. They run whenever a key resolves.
 * - **opt_in** decisions (task role routing, mission goal-criteria quality, the
 *   conflict-aware orchestration decisions): off unless the team row lists the
 *   capability in `teams.enabledDecisionShadows`. A new team starts with every
 *   one listed (`DEFAULT_ENABLED_DECISION_SHADOWS`). Since the 2026-10-03 owner
 *   decision, a new one ships applying (gated by its own rails and confidence
 *   threshold) as soon as it is turned on — "shadow" in some of these names is
 *   a holdover, not a separate logged-only phase a team must graduate out of.
 *   Turning one capability on never turns on another.
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
  | 'surface_audit_advice'
  | 'task_role_shadow'
  | 'task_role_apply'
  | 'orchestration_manifest'
  | 'orchestration_claim'
  | 'orchestration_ordering'
  | 'mission_strand_choice'
  | 'mission_goal_quality'
  | 'scout_probe_selection'
  | 'endpoint_model_match'
  | 'question_gate'
  | 'post_session_triage'
  | 'task_verdict'
  | 'early_release'
  | 'failure_incident_triage'
  | 'chat';

export type CapabilityKind = 'interactive' | 'built_in' | 'opt_in' | 'server_feature';

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
  surface_audit_advice: {
    id: 'surface_audit_advice',
    kind: 'built_in',
    label: 'Visual audit advice',
    description: 'When you open a mission that changed UI with no visual audit, a decision model suggests running the audit or waiving it. Only a suggestion; you always confirm.',
    costHint: '~$0.00003 per mission, cached',
  },
  // 2026-10-03 owner decision (knowledge-base: buildd/design/decision-calls.md):
  // applying is the default once either of these is on — there is no longer a
  // separate "logged only" tier for this decision. Both ids are kept (one
  // settings toggle is as good as two), and every look writes a row to the
  // decision ledger (packages/core/decision-ledger.ts) regardless of which name
  // enabled it.
  task_role_shadow: {
    id: 'task_role_shadow',
    kind: 'opt_in',
    label: 'Task role routing',
    description: 'When a decision model is confident, a task filed without a role gets one before a runner picks it up. Never replaces a role you chose, and never changes the model. Every look is recorded in the decision ledger.',
    costHint: '~$0.00003 per task',
  },
  task_role_apply: {
    id: 'task_role_apply',
    kind: 'opt_in',
    label: 'Task role routing (alias)',
    description: 'Same effect as "Task role routing" above — listing either is enough.',
    costHint: '~$0.00003 per task',
  },
  // Conflict-aware orchestration decisions (knowledge-base: buildd/design/conflict-aware-orchestration.md
  // §5, packages/core/orchestration-decision.ts). Opt-in shadows: they ship dark,
  // and opting in records suggestions only until a decision's applying cohort is
  // raised from zero after a held-out readout.
  orchestration_manifest: {
    id: 'orchestration_manifest',
    kind: 'opt_in',
    label: 'Scope prediction shadow',
    description: 'A decision model predicts which files a task filed without a scope will touch. Logged only until measured.',
    costHint: '~$0.0001 per task',
  },
  orchestration_claim: {
    id: 'orchestration_claim',
    kind: 'opt_in',
    label: 'Hold/start shadow',
    description: 'A decision model says whether an uncertain-scope task should wait or start. Logged only; never overrides a lease, migration or dependency gate.',
    costHint: '~$0.00003 per check',
  },
  // Jev ordering inputs (knowledge-base: buildd/design/jev-scheduling.md §5:
  // packages/core/orchestration-overlap-decision.ts and
  // task-size-bucket-decision.ts). Unlike orchestration_manifest/_claim, these
  // apply from the first PR (gated, logged) once a team opts in: by
  // construction they only ever move a claim-planner soft weight or a size
  // bucket, never a hard edge, a manifest or a dependsOn.
  orchestration_ordering: {
    id: 'orchestration_ordering',
    kind: 'opt_in',
    label: 'Ordering inputs',
    description: 'A decision model checks whether a predicted file overlap between two tasks is real, and sizes a task with too few similar completed tasks to size by precedent. Feeds the claim planner\'s ordering only; never a manifest or a dependency.',
    costHint: '~$0.00003 per look',
  },
  // Stranded local missions (apps/web/src/lib/strand-choice-decision.ts).
  // Shadow first: logged only; it can at most reorder the two buttons, and
  // only once its gate is raised in code after a readout. Never flips anything.
  mission_strand_choice: {
    id: 'mission_strand_choice',
    kind: 'opt_in',
    label: 'Stranded mission shadow',
    description: 'A decision model says whether a stranded local mission should continue on a runner or wait for your session. Logged only; you always choose.',
    costHint: '~$0.00003 per stranded mission, cached',
  },
  // Goal-criteria quality (apps/web/src/lib/goal-criteria-quality-decision.ts,
  // docs/specs/mission-goal-criteria-quality.md). Surfaces an `advisory` on the
  // response when the verdict lands in time and something is weak (2026-10-03:
  // GOAL_QUALITY_MODE ships `surface`, not shadow-only). Still never blocks or
  // rewrites the goal — advisory only, always confirmed by a person.
  mission_goal_quality: {
    id: 'mission_goal_quality',
    kind: 'opt_in',
    label: 'Goal quality advisory',
    description: 'A decision model says whether each new goal criterion states an outcome a user would notice and can be checked, and suggests a rewrite when it does not. Never blocks or changes your goal.',
    costHint: '~$0.0001 per goal edit, cached',
  },
  // Quality Scout probe selection (packages/core/decision-kind-scout-probe-selection.ts).
  // Shadow: the model's pick is recorded beside the deterministic must-run
  // rules and the heuristic fallback; the fallback is what runs until a readout.
  scout_probe_selection: {
    id: 'scout_probe_selection',
    kind: 'opt_in',
    label: 'Scout probe selection',
    description: 'When the quality scout checks finished work, a decision model suggests which of its candidate probes are worth running. Logged only; required probes always run.',
    costHint: '~$0.00003 per candidate probe',
  },
  // Agent endpoint model mapping (apps/web/src/lib/endpoint-model-suggest.ts).
  // Suggestion only, asked while an admin edits the endpoint; never saved
  // without them.
  endpoint_model_match: {
    id: 'endpoint_model_match',
    kind: 'built_in',
    label: 'Endpoint model suggestions',
    description: 'When an agent endpoint serves none of a model\'s names, a decision model suggests the closest model it does serve. Only a suggestion; you save the mapping.',
    costHint: '~$0.00003 per model, while editing',
  },
  // Question gate (packages/core/question-gate.ts). Runs only while the team
  // has a running `question_gate` experiment; the experiment is the opt-in.
  question_gate: {
    id: 'question_gate',
    kind: 'built_in',
    label: 'Question review',
    description: 'While your question-gate experiment runs, a decision model checks that an agent\'s question can be answered with no other context before it reaches you, and sends unclear ones back to the agent.',
    costHint: '~$0.00003 per question',
  },
  // Post-session quality triage (packages/core/post-session-triage.ts). Runs
  // in the background after a session ends, on bounded facts only; a
  // workspace turns the whole loop off with gitConfig.postSessionQuality.mode.
  post_session_triage: {
    id: 'post_session_triage',
    kind: 'built_in',
    label: 'Session quality triage',
    description: 'After an agent session ends, a decision model reads counts and outcomes (never code or text) and picks which sessions deserve a closer look. Never changes the task or its PR.',
    costHint: '~$0.00005 per session',
  },
  // Task verdict (apps/web/src/lib/task-verdict-decision.ts). Runs on a task
  // state change only (CI result, attempt end, PR event, worker terminal),
  // never on a page load, over the structured record (no transcripts).
  task_verdict: {
    id: 'task_verdict',
    kind: 'built_in',
    label: 'Task verdict wording',
    description: 'When a task\'s state changes, a decision model words its one-line verdict, picks which actions to offer, and sorts agent errors into real failures and exploration noise. The record always decides the state itself.',
    costHint: '~$0.00005 per state change',
  },
  // Early release (apps/web/src/lib/early-release-decision.ts). Live once on:
  // a confident model answer may start a dependent before its upstream merges.
  // The deterministic release rules apply without it; every failure waits.
  early_release: {
    id: 'early_release',
    kind: 'opt_in',
    label: 'Early release',
    description: 'When a task waits on another task\'s pull request, a decision model says whether it can safely start now instead of waiting for the merge. Anything it is unsure about waits.',
    costHint: '~$0.00003 per waiting task',
  },
  // Failure Pattern Sentinel triage (packages/core/decision-kind-failure-incident-triage.ts).
  // Opt-in: asked only when an incident below critical opens or changes. It can
  // raise an incident's severity, never lower the rule engine's floor.
  failure_incident_triage: {
    id: 'failure_incident_triage',
    kind: 'opt_in',
    label: 'Failure incident triage',
    description: 'When a repeated failure pattern opens or grows, a decision model reads its counts (never logs or code) and says whether it is noise, worth watching, a bug to fix, or worth paging you. It can only raise the alert level.',
    costHint: '~$0.00003 per incident change',
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

/** The opt-in capabilities. Only these may be listed in `teams.enabledDecisionShadows`. */
export const OPT_IN_CAPABILITIES = ALL_INFERENCE_CAPABILITIES.filter(c => INFERENCE_CAPABILITIES[c].kind === 'opt_in');

/**
 * What a new team row starts with in `enabledDecisionShadows`: every opt-in
 * decision (2026-10-04 owner decision, default on). Applied by the column's
 * insert default in `db/schema.ts`, so every path that creates a team gets it.
 * Existing teams keep what they stored, and an opt-in capability added later
 * is not switched on for them.
 */
export const DEFAULT_ENABLED_DECISION_SHADOWS: readonly InferenceCapability[] = Object.freeze([...OPT_IN_CAPABILITIES]);

/** The team columns the gate reads. */
export interface InferenceGate {
  featureModes?: unknown;
  /** `teams.enabledDecisionShadows`: the opt_in capabilities this team turned on. */
  enabledDecisionShadows?: unknown;
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
  if (d.kind === 'opt_in') {
    return Array.isArray(gate.enabledDecisionShadows) && gate.enabledDecisionShadows.includes(capability);
  }
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

/**
 * Validate an operator-supplied `teams.enabledDecisionShadows`: a list of
 * opt_in capability ids, or null. Deduped; empty stores as null, so the column
 * has one "none enabled" form. An unknown or non-opt_in id is an error, never
 * silently dropped: a typo would otherwise read as "enabled" to the operator.
 */
export function normalizeDecisionShadows(input: unknown): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (input === null) return { ok: true, value: null };
  if (!Array.isArray(input)) return { ok: false, error: 'enabledDecisionShadows must be an array of capability ids, or null' };
  const bad = input.filter(v => typeof v !== 'string' || !(OPT_IN_CAPABILITIES as string[]).includes(v));
  if (bad.length > 0) {
    return { ok: false, error: `enabledDecisionShadows accepts only opt-in capabilities (${OPT_IN_CAPABILITIES.join(', ')}); got ${bad.map(v => JSON.stringify(v)).join(', ')}` };
  }
  const value = [...new Set(input as string[])];
  return { ok: true, value: value.length > 0 ? value : null };
}
