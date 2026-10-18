/**
 * The trust rule over the runner isolation record (Living Spec "Runner
 * isolation", R-4, R-5, R-7).
 *
 * Every task resolves an isolation requirement: `protected` (confinement must
 * be enforced for its backend and mode) or `trusted_local` (it may run reduced,
 * but only on a runner whose operator opted in). The claim route decides with
 * `decideTaskIsolation` before handing a task out, and stamps the result on the
 * task context under TASK_ISOLATION_CONTEXT_KEY; the runner reads that stamp to
 * decide, again, whether a session may start unconfined and whether a mid-run
 * confinement failure may restart it.
 *
 * Pure and dependency-free, like ./runner-isolation.
 */
import {
  isIsolationRecordCurrent,
  isolationReasonText,
  isolationRemediation,
  type BackendConfinement,
  type CodexSandboxMode,
  type IsolationReason,
  type RunnerIsolationRecord,
} from './runner-isolation.js';

export type IsolationRequirement = 'protected' | 'trusted_local';
export const ISOLATION_REQUIREMENTS: readonly IsolationRequirement[] = ['protected', 'trusted_local'];

export function isIsolationRequirement(v: unknown): v is IsolationRequirement {
  return v === 'protected' || v === 'trusted_local';
}

/** What a run actually got: its backend's confinement, or less (R-5). */
export type EffectiveIsolationMode = 'enforced' | 'reduced';

export type IsolationBackend = 'claude' | 'codex';

/**
 * The runner operator's opt-in to reduced confinement for trusted_local work
 * (R-5). `BUILDD_DISABLE_SANDBOX=1` is an explicit operator act too: the
 * matrix runs trusted local work under it, labelled "disabled by operator".
 */
export const REDUCED_ISOLATION_OPT_IN_ENV = 'BUILDD_ALLOW_REDUCED_ISOLATION';

export function reducedIsolationOptedIn(env: Record<string, string | undefined>): boolean {
  return env[REDUCED_ISOLATION_OPT_IN_ENV] === '1' || env.BUILDD_DISABLE_SANDBOX === '1';
}

/** Codex's mode when the task names none: read-only for work that only reads. */
export function inferCodexSandboxMode(kind?: string | null): CodexSandboxMode {
  if (kind === 'research' || kind === 'analysis' || kind === 'observation') return 'read-only';
  return 'workspace-write';
}

/** The Codex mode a task runs in: its own `context.sandboxMode`, else by kind. */
export function taskCodexSandboxMode(kind: string | null | undefined, context: unknown): CodexSandboxMode {
  const own = (context as { sandboxMode?: unknown } | null | undefined)?.sandboxMode;
  if (own === 'read-only' || own === 'workspace-write') return own;
  return inferCodexSandboxMode(kind);
}

export type IsolationRequirementSource = 'workspace' | 'single_owner_team' | 'default';

/**
 * R-4: a task's requirement, from policy.
 *
 * - The workspace's `gitConfig.isolationPolicy`, when set, decides.
 * - Otherwise a team of exactly one member, on a workspace not open to other
 *   accounts, defaults to `trusted_local`: the only person whose work runs is
 *   the one who operates the runner. That alone runs nothing reduced; the
 *   runner operator's opt-in (R-5) is still the only switch for that.
 * - Everything else is `protected`: a shared team, an open workspace, or a
 *   team whose size could not be read.
 */
export function resolveIsolationRequirement(input: {
  workspacePolicy?: unknown;
  workspaceAccessMode?: string | null;
  teamMemberCount: number | null;
}): { requirement: IsolationRequirement; source: IsolationRequirementSource } {
  if (isIsolationRequirement(input.workspacePolicy)) return { requirement: input.workspacePolicy, source: 'workspace' };
  if (input.teamMemberCount === 1 && input.workspaceAccessMode !== 'open') {
    return { requirement: 'trusted_local', source: 'single_owner_team' };
  }
  return { requirement: 'protected', source: 'default' };
}

/** The confinement a record gives one backend in one mode. */
export function backendConfinement(
  record: RunnerIsolationRecord,
  backend: IsolationBackend,
  codexMode: CodexSandboxMode,
): BackendConfinement | null {
  if (backend === 'claude') return record.claude;
  return record.codex?.[codexMode] ?? null;
}

export type IsolationRefusal = 'probe_unknown' | 'confinement_not_enforced' | 'reduced_not_opted_in';

export type TaskIsolationDecision =
  | {
      ok: true;
      requirement: IsolationRequirement;
      mode: EffectiveIsolationMode;
      confinement: BackendConfinement;
    }
  | {
      ok: false;
      requirement: IsolationRequirement;
      code: IsolationRefusal;
      reason: IsolationReason | null;
      /** One sentence: what the runner lacks and what the task needs. */
      message: string;
      /** Steps for the runner operator; buildd never changes host settings. */
      remedy: string[];
    };

const BACKEND_TEXT = (backend: IsolationBackend, codexMode: CodexSandboxMode) =>
  backend === 'claude' ? 'Claude' : `Codex (${codexMode})`;

/**
 * R-4, R-5: may this runner run this task, and how confined.
 *
 * - No current probe (an older runner, or a record from before this process
 *   started, R-11): refused for both requirements. Nothing is known, so
 *   nothing may run reduced on the strength of it.
 * - Confinement enforced for the backend and mode: runs, `enforced`.
 * - Not enforced and `protected`: refused, with the cause and the steps.
 * - Not enforced and `trusted_local`: runs `reduced` only if the record says
 *   the operator opted in; otherwise refused.
 */
export function decideTaskIsolation(input: {
  requirement: IsolationRequirement;
  record: RunnerIsolationRecord | null | undefined;
  backend: IsolationBackend;
  codexMode: CodexSandboxMode;
}): TaskIsolationDecision {
  const { requirement, record, backend, codexMode } = input;
  const label = BACKEND_TEXT(backend, codexMode);
  if (!isIsolationRecordCurrent(record)) {
    return {
      ok: false,
      requirement,
      code: 'probe_unknown',
      reason: null,
      message: `This runner reported no current isolation probe, so whether it confines ${label} is unknown.`,
      remedy: ['Update the runner to a build that reports its isolation probe, or restart it so the probe runs again.'],
    };
  }
  const confinement = backendConfinement(record, backend, codexMode);
  if (confinement && confinement.mechanism !== 'none') {
    return { ok: true, requirement, mode: 'enforced', confinement };
  }
  const reason = confinement?.reason ?? 'backend_probe_failed';
  const cause = isolationReasonText(reason, record.platform);
  const fix = isolationRemediation(reason, record.platform);
  if (requirement === 'protected') {
    return {
      ok: false,
      requirement,
      code: 'confinement_not_enforced',
      reason,
      message: `The task needs protected isolation and this runner has no confinement for ${label}: ${cause}.`,
      remedy: fix,
    };
  }
  if (record.reducedOptIn === true) {
    return { ok: true, requirement, mode: 'reduced', confinement: confinement ?? { mechanism: 'none', scope: [], reason } };
  }
  return {
    ok: false,
    requirement,
    code: 'reduced_not_opted_in',
    reason,
    message: `This runner has no confinement for ${label} (${cause}), and its operator has not opted in to running trusted local work reduced.`,
    remedy: [...fix, `Or, to run trusted local work unconfined on this runner, set ${REDUCED_ISOLATION_OPT_IN_ENV}=1 and restart it.`],
  };
}

/**
 * The claim's decision, stamped on the task context the runner receives, so the
 * runner enforces the same rule (and R-7's restart rule) without a lookup.
 */
export const TASK_ISOLATION_CONTEXT_KEY = 'isolation';

export interface TaskIsolationStamp {
  requirement: IsolationRequirement;
  source: IsolationRequirementSource;
  /** The mode the claim decided; the runner re-decides from its own probe. */
  mode: EffectiveIsolationMode;
}

export function readTaskIsolationStamp(context: unknown): TaskIsolationStamp | null {
  const v = (context as Record<string, unknown> | null | undefined)?.[TASK_ISOLATION_CONTEXT_KEY];
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<TaskIsolationStamp>;
  if (!isIsolationRequirement(s.requirement)) return null;
  return {
    requirement: s.requirement,
    source: s.source === 'workspace' || s.source === 'single_owner_team' ? s.source : 'default',
    mode: s.mode === 'reduced' ? 'reduced' : 'enforced',
  };
}

/**
 * The requirement a runner enforces for a task. A task claimed by a server
 * that predates the stamp carries none and is held to `protected`: a runner
 * never guesses its way into less confinement.
 */
export function taskIsolationRequirement(context: unknown): IsolationRequirement {
  return readTaskIsolationStamp(context)?.requirement ?? 'protected';
}
