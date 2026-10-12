/**
 * One list of what is failing, for Health → Failures and Overview.
 *
 * Health used to show the same failure three times: Problems (24h, grouped by
 * signature), Worker failures (rate, exit cause, signatures) and Error trace
 * patterns (tool-output patterns ranked by failed workers). This folds them
 * into groups a person can act on:
 *
 * - A group is one cause, headed by a sentence buildd wrote. Known causes
 *   (the model provider's usage limit, workspace setup, budget, a missing
 *   Codex login, a run that ended without a PR) merge every variant under it;
 *   anything else groups by its cause category (the worker's exit cause), and
 *   the raw error text stays inside the expanded row as evidence.
 * - Every failed worker counts once, in exactly one group.
 * - Error-trace patterns are evidence under the group their worker is in,
 *   counted by distinct workers, never as a separate list.
 * - Work a person stopped (cancelled, aborted) is counted apart, not as a
 *   failure to fix. So is a fix or review buildd stopped because the work had
 *   already landed (its PR merged or was approved): nothing failed.
 * - A platform cause carries the state of the buildd incident that covers it,
 *   when there is one (`incidents`); a task cause carries what to do (`hint`).
 *
 * Pure: no db, no React. The query that feeds it lives in health-data.ts.
 */
import { normalizeErrorSignature } from './error-signature';
import { DISPATCH_MODEL_REJECTED_PATTERN } from '@buildd/core/dispatch-model-guard';
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';

export interface FailedWorkerInput {
  workerId: string;
  taskId: string | null;
  taskTitle: string | null;
  workspaceName: string;
  error: string | null;
  /** workers.exit_cause, or null when unclassified. */
  exitCause: string | null;
  /** ISO timestamp the worker ended. */
  completedAt: string;
}

export interface TracePatternInput {
  workerId: string;
  pattern: string;
}

/**
 * A failure_incidents row that may cover some of these failures, already put
 * into the one line the row shows (lib/failure-incident-states.ts).
 */
export interface IncidentStateInput {
  id: string;
  line: string;
  resolved: boolean;
  workerIds: readonly string[];
  taskIds: readonly string[];
  /** ISO; breaks ties between incidents covering the same group. */
  lastSeenAt: string;
}

/** `landed`: buildd stopped it because the work already landed. Neither it nor `stopped` is a failure. */
export type FailureKind = 'platform' | 'work' | 'stopped' | 'landed';

export interface FailureCause {
  key: string;
  kind: FailureKind;
  /** A sentence buildd wrote, for the group heading. Never raw error text. */
  label: string;
  /** One line on what to do, when there is something to do. */
  hint?: string;
}

export interface FailureGroup extends FailureCause {
  /** Distinct failed workers in this group. */
  count: number;
  workspaces: string[];
  /** Tasks with the most failed workers in this group, most first. */
  tasks: Array<{ taskId: string; title: string; failedWorkers: number }>;
  firstSeen: string;
  lastSeen: string;
  /** Raw error from the most recent member, for the drill-down. */
  sampleError: string | null;
  /** Distinct normalized signatures merged into this group, most common first. */
  variants: Array<{ signature: string; count: number }>;
  /** Error-trace patterns seen on this group's workers, by distinct workers. */
  patterns: Array<{ pattern: string; workers: number }>;
  /** Platform causes: the buildd incident covering this group, as one line. */
  incident?: { id: string; line: string };
}

export interface FailureGroupsView {
  groups: FailureGroup[];
  /** Distinct failed workers, stopped and landed work excluded. */
  totalFailedWorkers: number;
  platformFailures: number;
  workFailures: number;
  /** Workers a person stopped. Not failures. */
  stopped: number;
  /** Workers buildd stopped because the work already landed. Not failures. */
  landed: number;
}

interface Family {
  key: string;
  kind: FailureKind;
  label: string;
  hint?: string;
  test: (error: string, exitCause: string | null) => boolean;
}

const has = (re: RegExp) => (error: string) => re.test(error);

/** `Superseded — <rule label>` (lib/supersession-store.ts) for work whose PR merged or was approved. */
const LANDED_SUPERSESSION = /^Superseded\b.*(already merged|already approved|work landed)/i;

/** Checked in order; the first match names the cause. */
const FAMILIES: Family[] = [
  {
    key: 'landed:superseded', kind: 'landed', label: 'Stopped because the work already landed',
    test: has(LANDED_SUPERSESSION),
  },
  {
    key: 'stopped:by_person', kind: 'stopped', label: 'Stopped by a person',
    // Also a retry stopped because its task was cancelled, and an interactive
    // session handing its claim to a runner.
    test: (e, c) => c === 'task_cancelled'
      || /aborted by user|cancelled by user|^Superseded\b.*task cancelled|Released interactive MCP claim/i.test(e),
  },
  {
    key: 'platform:usage_limit', kind: 'platform', label: "Hit the model provider's usage limit",
    hint: 'Work resumes when the limit resets.',
    test: has(/session limit|usage limit|rate limit|hit your .*limit/i),
  },
  {
    key: 'platform:budget', kind: 'platform', label: 'Stopped by the spending limit',
    hint: 'Raise the budget or wait for the period to reset.',
    test: (e, c) => c === 'budget_limited' || /budget (exhausted|exceeded)/i.test(e),
  },
  {
    key: 'work:codex_credential', kind: 'work', label: "Codex isn't connected",
    hint: 'Connect a ChatGPT or OpenAI account in Settings › Models.',
    test: has(/codex (credential|auth)|chatgpt account/i),
  },
  {
    key: 'platform:provision', kind: 'platform', label: "Couldn't set up the workspace for the agent",
    test: has(/provision failed|\[provision\]/i),
  },
  {
    key: 'work:model_login', kind: 'work', label: 'The model provider refused the login',
    hint: 'Check the Claude key or login in Settings › Models.',
    test: e => classifyAuthErrorSeverity(e) !== 'none',
  },
  {
    key: 'platform:never_started', kind: 'platform', label: 'The agent never started',
    test: (_e, c) => c === 'never_started' || c === 'silent_start',
  },
  {
    key: 'platform:stale', kind: 'platform', label: 'The runner stopped reporting partway through',
    test: has(/stale worker expired/i),
  },
  {
    key: 'platform:sandbox', kind: 'platform', label: "The sandbox couldn't reach a folder it needed",
    test: (_e, c) => c === 'sandbox_mount_gap',
  },
  {
    key: 'platform:infra', kind: 'platform', label: 'The runner or its machine failed',
    test: (_e, c) => c === 'infra_failure',
  },
  {
    key: 'platform:refused', kind: 'platform', label: 'buildd refused a request the agent made',
    test: (_e, c) => c === 'server_refused',
  },
  {
    key: 'work:output_unmet', kind: 'work', label: 'Finished without the required output',
    hint: 'The task needed a PR or an artifact. Retry it, or say in the task what it should produce.',
    test: (e, c) => c === 'output_unmet'
      || /no confirmed outcome|no pull request or artifact|No PR was created/i.test(e),
  },
  {
    key: 'work:review_no_verdict', kind: 'work', label: 'The review finished without a verdict',
    hint: 'Request the review again.',
    test: has(/without structuredOutput\.verdict/i),
  },
  {
    key: 'work:agent_error', kind: 'work', label: 'The agent stopped with an error from the model',
    hint: 'Retry the task.',
    test: has(/Agent SDK returned an error/i),
  },
  {
    key: 'work:needs_input', kind: 'work', label: 'Stopped to ask a question nobody answered',
    hint: 'Answer it on the task to let the agent continue.',
    test: (e, c) => c === 'needs_input' || /^needs_input:/i.test(e),
  },
];

/**
 * A failure buildd has no sentence for, named by its cause category. The raw
 * text is the group's sample error and variants, shown inside the row.
 */
const CATEGORY_LABEL: Record<string, string> = {
  code_failure: "The agent hit an error it couldn't recover from",
  condition_unmet: "Something the task waits for wasn't ready",
  reassigned: 'Handed to another runner before it finished',
  unknown: 'The run failed',
};

/** Which cause a failed worker belongs to. */
export function classifyFailure(error: string | null, exitCause: string | null): FailureCause {
  const text = error ?? '';
  for (const f of FAMILIES) {
    if (f.test(text, exitCause)) return { key: f.key, kind: f.kind, label: f.label, ...(f.hint ? { hint: f.hint } : {}) };
  }
  if (!error && !exitCause) return { key: 'cause:none', kind: 'work', label: 'Failed with no error message' };
  const category = exitCause && CATEGORY_LABEL[exitCause] ? exitCause : 'unknown';
  return { key: `cause:${category}`, kind: 'work', label: CATEGORY_LABEL[category] };
}

interface Acc {
  cause: FailureCause;
  workers: Set<string>;
  workspaces: Set<string>;
  tasks: Map<string, { title: string; workers: Set<string> }>;
  firstSeen: string;
  lastSeen: string;
  sampleError: string | null;
  variants: Map<string, number>;
  patterns: Map<string, Set<string>>;
}

export function buildFailureGroups({
  failures,
  traces,
  incidents = [],
  maxTasks = 5,
  maxPatterns = 3,
  maxVariants = 3,
}: {
  failures: readonly FailedWorkerInput[];
  traces: readonly TracePatternInput[];
  incidents?: readonly IncidentStateInput[];
  maxTasks?: number;
  maxPatterns?: number;
  maxVariants?: number;
}): FailureGroupsView {
  // One row per worker: a duplicate in the input must not count twice.
  const byWorker = new Map<string, FailedWorkerInput>();
  for (const f of failures) if (!byWorker.has(f.workerId)) byWorker.set(f.workerId, f);

  const groupOfWorker = new Map<string, string>();
  const accs = new Map<string, Acc>();
  let stopped = 0;
  let landed = 0;

  for (const f of byWorker.values()) {
    const cause = classifyFailure(f.error, f.exitCause);
    if (cause.kind === 'stopped') { stopped++; continue; }
    if (cause.kind === 'landed') { landed++; continue; }
    let acc = accs.get(cause.key);
    if (!acc) {
      acc = {
        cause, workers: new Set(), workspaces: new Set(), tasks: new Map(),
        firstSeen: f.completedAt, lastSeen: f.completedAt, sampleError: f.error,
        variants: new Map(), patterns: new Map(),
      };
      accs.set(cause.key, acc);
    }
    acc.workers.add(f.workerId);
    acc.workspaces.add(f.workspaceName);
    if (f.completedAt < acc.firstSeen) acc.firstSeen = f.completedAt;
    if (f.completedAt >= acc.lastSeen) { acc.lastSeen = f.completedAt; acc.sampleError = f.error; }
    if (f.taskId) {
      const t = acc.tasks.get(f.taskId) ?? { title: f.taskTitle ?? 'Untitled task', workers: new Set<string>() };
      t.workers.add(f.workerId);
      acc.tasks.set(f.taskId, t);
    }
    const sig = normalizeErrorSignature(f.error);
    acc.variants.set(sig, (acc.variants.get(sig) ?? 0) + 1);
    groupOfWorker.set(f.workerId, cause.key);
  }

  for (const t of traces) {
    const key = groupOfWorker.get(t.workerId);
    if (!key) continue; // a trace on a worker that didn't fail is not evidence for any group
    // Nor is a claim-time model substitution: nearly every claim records one
    // and the run continues on the fallback model.
    if (t.pattern === DISPATCH_MODEL_REJECTED_PATTERN) continue;
    const acc = accs.get(key)!;
    const set = acc.patterns.get(t.pattern) ?? new Set<string>();
    set.add(t.workerId);
    acc.patterns.set(t.pattern, set);
  }

  const groups: FailureGroup[] = [...accs.values()]
    .map(acc => ({
      ...acc.cause,
      ...coveringIncident(acc, incidents),
      count: acc.workers.size,
      workspaces: [...acc.workspaces],
      tasks: [...acc.tasks.entries()]
        .map(([taskId, t]) => ({ taskId, title: t.title, failedWorkers: t.workers.size }))
        .sort((a, b) => b.failedWorkers - a.failedWorkers || a.title.localeCompare(b.title))
        .slice(0, maxTasks),
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
      sampleError: acc.sampleError,
      variants: [...acc.variants.entries()]
        .map(([signature, count]) => ({ signature, count }))
        .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
        .slice(0, maxVariants),
      patterns: [...acc.patterns.entries()]
        .map(([pattern, ws]) => ({ pattern, workers: ws.size }))
        .sort((a, b) => b.workers - a.workers || a.pattern.localeCompare(b.pattern))
        .slice(0, maxPatterns),
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.key.localeCompare(b.key));

  const platformFailures = groups.filter(g => g.kind === 'platform').reduce((n, g) => n + g.count, 0);
  const workFailures = groups.filter(g => g.kind === 'work').reduce((n, g) => n + g.count, 0);
  return { groups, totalFailedWorkers: platformFailures + workFailures, platformFailures, workFailures, stopped, landed };
}

/**
 * The incident covering a platform group: one naming any of its workers, else
 * any of its tasks. An open one beats a resolved one, then the most recent.
 */
function coveringIncident(acc: Acc, incidents: readonly IncidentStateInput[]): { incident?: { id: string; line: string } } {
  if (acc.cause.kind !== 'platform' || incidents.length === 0) return {};
  const covers = (i: IncidentStateInput) =>
    i.workerIds.some(id => acc.workers.has(id)) || i.taskIds.some(id => acc.tasks.has(id));
  const best = incidents
    .filter(covers)
    .sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  return best ? { incident: { id: best.id, line: best.line } } : {};
}
