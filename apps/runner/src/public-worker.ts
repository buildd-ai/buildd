/**
 * Public projection of a LocalWorker for the runner's HTTP and SSE surfaces.
 *
 * Invariant: nothing the runner serialises to a client (`/api/workers`,
 * `/api/claim`, the `/api/events` init payload, or any broadcast event) carries
 * credential material. A LocalWorker holds the credentials its session needs
 * (server-issued tokens, MCP secrets, backend credentials, presigned config
 * URLs), so it must never be handed to `JSON.stringify` / `Response.json` raw.
 *
 * This is an allowlist, not a denylist: a field is only emitted if it is listed
 * here as `true`. Fields set on a worker ad hoc (outside the LocalWorker type)
 * and fields added to the type later are withheld until someone classifies them.
 * `public-worker.test.ts` fails when LocalWorker gains a field that is not
 * classified below, so the choice is made deliberately rather than by default.
 */
import type { LocalWorker } from './types';

/**
 * Credential material and credential handles — never serialised. PublicWorker
 * omits these at the type level, and WORKER_FIELD_VISIBILITY's type forces each
 * of them to `false` (and every other field to `true`).
 */
export const WITHHELD_WORKER_FIELDS = [
  'mcpSecrets',
  'serverApiKey',
  'serverOauthToken',
  'claudeAccessToken',
  'claudeTokenExpiresAt',
  'claudeCredentialId',
  'codexCredential',
  'roleConfig', // carries a presigned download URL
  'assertionTokenCache',
  'assertionReAuthFailed',
  'roleEnvSecrets', // resolved secret VALUES (ENV_NAME -> value), never client-safe
  'modelEndpoint', // the team agent model endpoint's key
  // Prompt text: the role persona, the skill bodies and the packaged role
  // bundle. Not credentials, but never echoed to a client either.
  'roleInstructions',
  'skillBundles',
  'roleBundle',
] as const satisfies ReadonlyArray<keyof LocalWorker>;

export type WithheldWorkerField = (typeof WITHHELD_WORKER_FIELDS)[number];

/** true = safe to serialise to clients; false = withheld. */
export const WORKER_FIELD_VISIBILITY: Record<Exclude<keyof LocalWorker, WithheldWorkerField>, true> &
  Record<WithheldWorkerField, false> = {
  id: true,
  taskId: true,
  taskTitle: true,
  taskDescription: true,
  parentTaskId: true,
  taskMode: true,
  taskBackend: true,
  promptBundlesLoaded: true, // a boolean, no prompt text
  workspaceId: true,
  workspaceName: true,
  workspaceDataClass: true,
  branch: true,
  status: true,
  hasNewActivity: true,
  startedAt: true,
  lastActivity: true,
  toolInFlight: true,
  killedByRestart: true,
  completedAt: true,
  milestones: true,
  currentAction: true,
  commits: true,
  prCreated: true,
  prUrl: true,
  sessionEndPushCount: true,
  sessionEndPushes: true,
  lastToolDenial: true,
  output: true,
  toolCalls: true,
  messages: true,
  sessionId: true,
  codexThreadId: true,
  error: true,
  waitingFor: true,
  teamState: true,
  subagentTasks: true,
  subagentTasksObservedCount: true,
  worktreePath: true,
  sessionCwd: true,
  worktreeBaseRef: true,
  prBaseRef: true,
  envDegraded: true,
  checkpoints: true,
  checkpointEvents: true,
  pendingMcpCalls: true,
  pendingErrorTraces: true,
  pendingActionEvents: true,
  pendingPromptCompositionEvents: true,
  promptBuildIndex: true,
  pendingPaths: true,
  workingSet: true,
  pendingShipReports: true,
  shipCoverageMilestones: true,
  pathClaimMode: true,
  pathCollision: true,
  pathCollisionDeferring: true,
  pathClaimDegraded: true,
  pathClaimDegradedReported: true,
  pathClaimDegradedByCause: true,
  pathClaimDegradedByCauseReported: true,
  pathSweepBaseFetchedAt: true,
  lastAssistantMessage: true,
  tokenTally: true,
  sandboxMountGap: true,
  bwrapRetryPending: true,
  phaseText: true,
  phaseStart: true,
  phaseToolCount: true,
  phaseTools: true,
  sessionModel: true,
  reportedModel: true,
  resultMeta: true,
  questionGate: true,
  claudeAiArtifacts: true,
  claudeTokenScopes: true,
  questionPushbacks: true,
  lastEditedFile: true,
  toolCounts: true,
  bashCommandCounts: true,
  fileToolAreas: true,
  degradedConnectors: true,
  assertionConnectors: true,
  promptSuggestions: true,
  loopNudgeSent: true,
  currentPromptId: true,
  commandLifecycle: true,
  modelCapabilities: true,
  roleEnvMissing: true,
  modelEndpointIgnored: true,
  githubCredentials: true, // a mode marker; the token itself is never on the worker

  // Withheld — see WITHHELD_WORKER_FIELDS.
  mcpSecrets: false,
  serverApiKey: false,
  serverOauthToken: false,
  claudeAccessToken: false,
  claudeTokenExpiresAt: false,
  claudeCredentialId: false,
  codexCredential: false,
  modelEndpoint: false,
  roleConfig: false,
  roleInstructions: false,
  skillBundles: false,
  roleBundle: false,
  assertionTokenCache: false,
  assertionReAuthFailed: false,
  roleEnvSecrets: false,
};

const PUBLIC_FIELDS: ReadonlyArray<keyof LocalWorker> = (
  Object.keys(WORKER_FIELD_VISIBILITY) as Array<keyof LocalWorker>
).filter((k) => (WORKER_FIELD_VISIBILITY as Record<string, boolean>)[k]);

/** A projected worker. Credential fields are absent from the type itself. */
export type PublicWorker = Partial<Omit<LocalWorker, WithheldWorkerField>>;

/** Project a worker onto its allowlisted, client-safe fields. */
export function toPublicWorker(worker: LocalWorker): PublicWorker {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_FIELDS) {
    const value = (worker as any)[field];
    if (value !== undefined) out[field] = value;
  }
  return out as PublicWorker;
}

export function toPublicWorkers(workers: Iterable<LocalWorker>): PublicWorker[] {
  return Array.from(workers, toPublicWorker);
}

/** A LocalWorker always carries a string `id` and `status`. */
function isWorkerShaped(value: unknown): value is LocalWorker {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any).id === 'string' &&
    typeof (value as any).status === 'string'
  );
}

/**
 * Project any runner event before it is broadcast to SSE clients. A `worker`
 * payload (e.g. `worker_update`) and each element of a `workers` payload are
 * projected when they are worker-shaped; ids, summaries and everything else
 * pass through unchanged.
 */
export function toPublicEvent<T>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  const e = event as any;
  const hasWorker = isWorkerShaped(e.worker);
  const hasWorkers = Array.isArray(e.workers) && e.workers.some(isWorkerShaped);
  if (!hasWorker && !hasWorkers) return event;
  const out = { ...e };
  if (hasWorker) out.worker = toPublicWorker(e.worker);
  if (hasWorkers) out.workers = e.workers.map((x: unknown) => (isWorkerShaped(x) ? toPublicWorker(x) : x));
  return out;
}
