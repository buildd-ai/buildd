/**
 * `?state=run-activity`: the task page's run-detail view (Now strip, activity
 * tape, steering history, worker history, failure evidence) over the scenarios
 * the evidence-backed run progress mission must hold at 360px and on desktop.
 *
 *   ?state=run-activity                       every scenario, stacked
 *   &scenario=<key>                           one scenario (what the QA plan shoots)
 *
 * Captured by scripts/qa/plans/run-activity.json, whose `assertLayout` state
 * fails the capture on horizontal overflow or a sub-44px tap target.
 *
 * Every timestamp derives from BASE (no Date.now() at module scope: this is
 * imported by a client component and must hydrate identically). Placeholder
 * names only: the repo is public.
 */
import type { WorkerMilestone } from '@buildd/core/db/schema';
import type { TaskEvidence } from '@buildd/shared';

const MINUTE = 60_000;
// 2024-07-03T12:00:00.000Z, the same instant fixtures-data.ts uses.
const BASE = 1_720_008_000_000;
const iso = (msAgo: number) => new Date(BASE - msAgo).toISOString();
const at = (minAgo: number) => BASE - minAgo * MINUTE;

export const RUN_ACTIVITY_FIXTURE_STATE = 'run-activity';

export const RUN_ACTIVITY_SCENARIOS = [
  'research-lifecycle',
  'legacy-percent-stream',
  'waiting-input',
  'error',
  'steering-acks',
  'attempts-tie',
] as const;
export type RunActivityScenario = (typeof RUN_ACTIVITY_SCENARIOS)[number];

export const RUN_ACTIVITY_SCENARIO_TITLES: Record<RunActivityScenario, string> = {
  'research-lifecycle': 'Research task: no code phases',
  'legacy-percent-stream': 'Legacy worker: percent stream 40 → 70 → 30 → 90',
  'waiting-input': 'Waiting for input',
  error: 'Failed run',
  'steering-acks': 'Steering messages: queued, delivered, acknowledged, undelivered',
  'attempts-tie': 'Attempts with equal timestamps',
};

/** Pure: `&scenario=` to the scenarios the page renders. Unknown or absent = all. */
export function parseRunActivityScenario(q: URLSearchParams): RunActivityScenario[] {
  const s = q.get('scenario');
  return (RUN_ACTIVITY_SCENARIOS as readonly string[]).includes(s ?? '') ? [s as RunActivityScenario] : [...RUN_ACTIVITY_SCENARIOS];
}

/** The shape RealTimeWorkerView takes, as far as these fixtures fill it. */
export interface RunActivityWorker {
  id: string;
  name: string;
  branch: string;
  status: string;
  currentAction: string | null;
  milestones: WorkerMilestone[];
  turns: number;
  costUsd: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  prUrl: string | null;
  prNumber: number | null;
  localUiUrl: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  lastCommitSha: string | null;
  waitingFor: { type: string; prompt: string; options?: string[] } | null;
  instructionHistory: SteeringEntry[];
  pendingInstructions: string | null;
  updatedAt: string | null;
  error?: string | null;
}

function worker(id: string, over: Partial<RunActivityWorker>): RunActivityWorker {
  return {
    id,
    name: `fixture-${id}`,
    branch: `buildd/fixture-${id}`,
    status: 'running',
    currentAction: null,
    milestones: [],
    turns: 18,
    costUsd: null,
    inputTokens: 42_000,
    outputTokens: 9_000,
    startedAt: iso(40 * MINUTE),
    prUrl: null,
    prNumber: null,
    localUiUrl: null,
    commitCount: null,
    filesChanged: null,
    linesAdded: null,
    linesRemoved: null,
    lastCommitSha: null,
    waitingFor: null,
    instructionHistory: [],
    pendingInstructions: null,
    updatedAt: iso(0),
    ...over,
  };
}

// ── (1) Research task: reads and reports, never edits, commits or opens a PR ──

export const researchWorker = worker('research', {
  currentAction: 'Comparing retry strategies',
  milestones: [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: at(40) },
    { type: 'checkpoint', event: 'first_read', label: 'First file read', ts: at(38) },
    { type: 'action', label: 'Read docs/retries.md', tool: 'Read', path: 'docs/retries.md', ts: at(38) },
    { type: 'action', label: 'Read src/client/backoff.ts', tool: 'Read', path: 'src/client/backoff.ts', count: 4, ts: at(30) },
    { type: 'action', label: 'Ran: rg -n "retry" src', tool: 'Bash', cmd: 'rg -n "retry" src', ts: at(22) },
    { type: 'status', label: 'Comparing three retry strategies against the incident timeline', ts: at(12) },
    { type: 'action', label: 'Read src/client/http.ts', tool: 'Read', path: 'src/client/http.ts', ts: at(4) },
  ],
});

// ── (2) Legacy worker: self-reported percentages that go backwards ──

/** The non-monotonic stream an old agent reported, oldest first. */
export const LEGACY_PERCENT_STREAM = [40, 70, 30, 90] as const;
/** What the view must lead with: the newest status label, not a number. */
export const LEGACY_LATEST_HEADLINE = 'Wiring the retry budget into the client';

export const legacyStreamWorker = worker('legacy-stream', {
  currentAction: 'Editing client',
  commitCount: 2,
  filesChanged: 3,
  linesAdded: 84,
  linesRemoved: 12,
  milestones: [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: at(40) },
    { type: 'checkpoint', event: 'first_read', label: 'First file read', ts: at(39) },
    { type: 'status', label: 'Mapped the client call sites', progress: LEGACY_PERCENT_STREAM[0], ts: at(34) },
    { type: 'checkpoint', event: 'first_edit', label: 'First file edit', ts: at(30) },
    { type: 'action', label: 'Edited src/client/backoff.ts', tool: 'Edit', path: 'src/client/backoff.ts', add: 40, rem: 6, ts: at(30) },
    { type: 'status', label: 'Backoff rewritten, tests next', progress: LEGACY_PERCENT_STREAM[1], ts: at(24) },
    { type: 'action', label: 'Ran: bun test src/client', tool: 'Bash', cmd: 'bun test src/client', ts: at(20) },
    { type: 'status', label: 'Two tests fail, re-planning the budget', progress: LEGACY_PERCENT_STREAM[2], ts: at(16) },
    { type: 'checkpoint', event: 'first_commit', label: 'First commit', ts: at(10) },
    { type: 'status', label: LEGACY_LATEST_HEADLINE, progress: LEGACY_PERCENT_STREAM[3], ts: at(6) },
    { type: 'action', label: 'Edited src/client/http.ts', tool: 'Edit', path: 'src/client/http.ts', add: 44, rem: 6, ts: at(2) },
  ],
});

// ── (3) Waiting for input, and a failed run ──

export const WAITING_PROMPT = 'Should the retry budget be per request or per client?';

export const waitingWorker = worker('waiting', {
  status: 'waiting_input',
  currentAction: 'Retry budget scope',
  waitingFor: { type: 'question', prompt: WAITING_PROMPT, options: ['Per request', 'Per client'] },
  milestones: [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: at(40) },
    { type: 'checkpoint', event: 'first_edit', label: 'First file edit', ts: at(30) },
    { type: 'action', label: 'Edited src/client/backoff.ts', tool: 'Edit', path: 'src/client/backoff.ts', add: 12, rem: 2, ts: at(30) },
    { type: 'status', label: 'Budget scope is ambiguous in the spec', ts: at(8) },
  ],
});

export const FAILED_ERROR = 'Tests failed: 2 failing in src/client/backoff.test.ts';

export const failedWorker = worker('failed', {
  status: 'failed',
  startedAt: iso(60 * MINUTE),
  error: FAILED_ERROR,
  milestones: [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: at(60) },
    { type: 'action', label: 'Ran: bun test src/client', tool: 'Bash', cmd: 'bun test src/client', ts: at(32) },
  ],
});

export const failedEvidence: TaskEvidence = {
  errorClass: 'test_failure',
  keyLines: [
    '✗ backoff > caps the delay at the budget',
    '  expected 8000 to be at most 5000',
    '✗ backoff > resets after a success',
  ],
  lastFailingCommand: { command: 'bun test src/client', exitCode: 1 },
  diff: { files: 2, added: 52, removed: 8 },
  links: {},
  keyLinesSource: 'traces',
  capturedAt: iso(30 * MINUTE),
};

// ── (4) Steering messages in each delivery state ──

/**
 * The instruction-history entry as it is stored today plus the fields the
 * steering task adds (`id`, `deliveredAt`, `acknowledgedAt`, and
 * `deliveryState: 'acknowledged'`), all inside the existing JSONB.
 */
export interface SteeringEntry {
  type: 'instruction' | 'response';
  message: string;
  timestamp: number;
  deliveryState?: 'pending' | 'delivered' | 'acknowledged';
  id?: string;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

/** What each human message should read as, keyed by its message text. */
export type SteeringDisplayState = 'queued' | 'delivered' | 'acknowledged' | 'undelivered';

export const STEERING_MESSAGES: Record<SteeringDisplayState, string> = {
  acknowledged: 'Keep the public signature unchanged.',
  delivered: 'Skip the flaky network test for now.',
  queued: 'Add a changelog line when you are done.',
  undelivered: 'Also cover the timeout path.',
};

/** A live worker: one message read, one in the session, one still queued. */
export const steeringLiveWorker = worker('steer-live', {
  currentAction: 'Editing client',
  milestones: [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: at(40) },
    { type: 'action', label: 'Edited src/client/http.ts', tool: 'Edit', path: 'src/client/http.ts', add: 10, rem: 1, ts: at(3) },
  ],
  instructionHistory: [
    { type: 'instruction', id: 'msg-ack', message: STEERING_MESSAGES.acknowledged, timestamp: at(20), deliveryState: 'acknowledged', deliveredAt: at(19), acknowledgedAt: at(18) },
    { type: 'response', message: 'Understood, signature stays.', timestamp: at(18) },
    { type: 'instruction', id: 'msg-delivered', message: STEERING_MESSAGES.delivered, timestamp: at(6), deliveryState: 'delivered', deliveredAt: at(5) },
    { type: 'instruction', id: 'msg-queued', message: STEERING_MESSAGES.queued, timestamp: at(1), deliveryState: 'pending' },
  ],
  pendingInstructions: STEERING_MESSAGES.queued,
});

/** An ended worker: a message still queued when the run ended was never delivered. */
export const steeringEndedWorker = worker('steer-ended', {
  status: 'completed',
  instructionHistory: [
    { type: 'instruction', id: 'msg-undelivered', message: STEERING_MESSAGES.undelivered, timestamp: at(12), deliveryState: 'pending' },
  ],
});

// ── (5) Attempts created in the same instant ──

export interface AttemptWorker {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  prNumber: number | null;
}

/** One instant shared by every worker: no timestamp can order them. */
export const ATTEMPT_TIE_AT = new Date(at(30));

/** The task's own worker, then two CI-fix attempts, all created at ATTEMPT_TIE_AT. */
export const attemptTie: { own: AttemptWorker[]; attempts: Array<{ workers: AttemptWorker[] }> } = {
  own: [{ id: 'attempt-a', name: 'fixture-runner-a', status: 'completed', createdAt: ATTEMPT_TIE_AT, prNumber: 101 }],
  attempts: [
    { workers: [{ id: 'attempt-b', name: 'fixture-runner-b', status: 'failed', createdAt: ATTEMPT_TIE_AT, prNumber: null }] },
    { workers: [{ id: 'attempt-c', name: 'fixture-runner-c', status: 'running', createdAt: ATTEMPT_TIE_AT, prNumber: null }] },
  ],
};

/** The status flip the fixture applies: the live attempt finishes. Must not move any row. */
export const ATTEMPT_FLIP = { id: 'attempt-c', from: 'running', to: 'completed' } as const;

export function withFlippedStatus(src: typeof attemptTie, flip: { id: string; to: string }): typeof attemptTie {
  const f = (w: AttemptWorker) => (w.id === flip.id ? { ...w, status: flip.to } : w);
  return { own: src.own.map(f), attempts: src.attempts.map(a => ({ workers: a.workers.map(f) })) };
}

/** The fixed "now" every scenario renders against, so ages read the same each load. */
export const RUN_ACTIVITY_NOW = BASE;
