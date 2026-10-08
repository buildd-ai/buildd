/**
 * One list of what is failing, for Health → Failures and Overview.
 *
 * Health used to show the same failure three times: Problems (24h, grouped by
 * signature), Worker failures (rate, exit cause, signatures) and Error trace
 * patterns (tool-output patterns ranked by failed workers). This folds them
 * into groups a person can act on:
 *
 * - A group is one cause. Known platform causes (the model provider's usage
 *   limit, workspace setup, budget, an agent that never started) merge every
 *   variant under one plain label; anything else groups by its normalized
 *   error signature.
 * - Every failed worker counts once, in exactly one group.
 * - Error-trace patterns are evidence under the group their worker is in,
 *   counted by distinct workers, never as a separate list.
 * - Work a person stopped (cancelled, aborted) is counted apart, not as a
 *   failure to fix.
 *
 * Pure: no db, no React. The query that feeds it lives in health-data.ts.
 */
import { normalizeErrorSignature } from './error-signature';
import { DISPATCH_MODEL_REJECTED_PATTERN } from '@buildd/core/dispatch-model-guard';

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

export type FailureKind = 'platform' | 'work' | 'stopped';

export interface FailureCause {
  key: string;
  kind: FailureKind;
  /** Plain words, for the group heading. */
  label: string;
  /** One line on what it usually means or what to do, when known. */
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
}

export interface FailureGroupsView {
  groups: FailureGroup[];
  /** Distinct failed workers, stopped work excluded. */
  totalFailedWorkers: number;
  platformFailures: number;
  workFailures: number;
  /** Workers a person stopped. Not failures. */
  stopped: number;
}

interface Family {
  key: string;
  kind: FailureKind;
  label: string;
  hint?: string;
  test: (error: string, exitCause: string | null) => boolean;
}

const has = (re: RegExp) => (error: string) => re.test(error);

/** Checked in order; the first match names the cause. */
const FAMILIES: Family[] = [
  {
    key: 'stopped:by_person', kind: 'stopped', label: 'Stopped by a person',
    test: (e, c) => c === 'task_cancelled' || /aborted by user|cancelled by user/i.test(e),
  },
  {
    key: 'platform:usage_limit', kind: 'platform', label: "Hit the model provider's usage limit",
    hint: 'Work resumes when the limit resets. Nothing to fix in the task.',
    test: has(/session limit|usage limit|rate limit|hit your .*limit/i),
  },
  {
    key: 'platform:budget', kind: 'platform', label: 'Stopped by the spending limit',
    hint: 'Raise the budget or wait for the period to reset.',
    test: (e, c) => c === 'budget_limited' || /budget (exhausted|exceeded)/i.test(e),
  },
  {
    key: 'platform:provision', kind: 'platform', label: "Couldn't set up the workspace for the agent",
    hint: 'A setup step on the runner failed before the agent started.',
    test: has(/provision failed|\[provision\]/i),
  },
  {
    key: 'platform:never_started', kind: 'platform', label: 'The agent never started',
    test: (_e, c) => c === 'never_started' || c === 'silent_start',
  },
  {
    key: 'platform:sandbox', kind: 'platform', label: "The sandbox couldn't reach a folder it needed",
    test: (_e, c) => c === 'sandbox_mount_gap',
  },
  {
    key: 'platform:infra', kind: 'platform', label: 'Runner or infrastructure failure',
    test: (_e, c) => c === 'infra_failure',
  },
  {
    key: 'platform:refused', kind: 'platform', label: 'buildd refused a request the agent made',
    test: (_e, c) => c === 'server_refused',
  },
  {
    key: 'work:output_unmet', kind: 'work', label: 'Finished without the required output',
    hint: 'The task needed a PR or an artifact and the agent produced neither.',
    test: (_e, c) => c === 'output_unmet',
  },
  {
    key: 'work:needs_input', kind: 'work', label: 'Stopped to ask a question nobody answered',
    test: (e, c) => c === 'needs_input' || /^needs_input:/i.test(e),
  },
];

const MAX_LABEL = 90;

function firstLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? text;
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line;
}

/** Which cause a failed worker belongs to. */
export function classifyFailure(error: string | null, exitCause: string | null): FailureCause {
  const text = error ?? '';
  for (const f of FAMILIES) {
    if (f.test(text, exitCause)) return { key: f.key, kind: f.kind, label: f.label, ...(f.hint ? { hint: f.hint } : {}) };
  }
  const signature = normalizeErrorSignature(error);
  return {
    key: `signature:${signature}`,
    kind: 'work',
    label: error ? firstLine(signature) : 'Failed with no error message',
  };
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
  maxTasks = 5,
  maxPatterns = 3,
  maxVariants = 3,
}: {
  failures: readonly FailedWorkerInput[];
  traces: readonly TracePatternInput[];
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

  for (const f of byWorker.values()) {
    const cause = classifyFailure(f.error, f.exitCause);
    if (cause.kind === 'stopped') { stopped++; continue; }
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
  return { groups, totalFailedWorkers: platformFailures + workFailures, platformFailures, workFailures, stopped };
}
