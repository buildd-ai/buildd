import { describe, it, expect } from 'bun:test';
import {
  evaluateAnswerPath,
  describeAnswerPath,
  buildContinuationDescription,
  buildContinuationTaskValues,
  buildAnswerDeliveryRecord,
  ANSWER_PATH_REASONS,
  RESUME_RUNNER_FRESH_MS,
  RESUME_MAX_TURNS,
  RESUME_ACK_DEADLINE_MS,
  explainNotWaiting,
  isAnswerableWaitingFor,
  type AnswerPathInput,
} from './answer-resume';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

/** A worker that clears every gate. Individual tests break exactly one. */
function eligible(overrides: Partial<AnswerPathInput> = {}): AnswerPathInput {
  return {
    workerStatus: 'waiting_input',
    workerUpdatedAt: new Date(NOW - 5_000),
    workerTurns: 40,
    supportsInstructionAck: true,
    credentialPreflight: 'ok',
    now: NOW,
    ...overrides,
  };
}

describe('evaluateAnswerPath', () => {
  // AC-AQR-1
  it('resumes a parked, freshly-synced, ack-capable worker with headroom and a healthy credential', () => {
    const decision = evaluateAnswerPath(eligible());
    expect(decision.path).toBe('resume');
    expect(decision.reasonCode).toBe('resume_eligible');
    expect(decision.reason).toBe(ANSWER_PATH_REASONS.resume_eligible);
  });

  // AC-AQR-2 — G1. An `error` worker may still carry waitingFor (that is the
  // /respond contract) but the runner already deleted its worktree.
  it.each([['error'], ['failed'], ['completed'], ['running'], [null]])(
    'falls back when the worker status is %p rather than waiting_input',
    (status) => {
      const decision = evaluateAnswerPath(eligible({ workerStatus: status as string | null }));
      expect(decision.path).toBe('cold_continuation');
      expect(decision.reasonCode).toBe('worker_not_parked');
    },
  );

  // AC-AQR-3 — G2
  it('falls back when the owning runner has stopped syncing the worker', () => {
    const decision = evaluateAnswerPath(
      eligible({ workerUpdatedAt: new Date(NOW - RESUME_RUNNER_FRESH_MS - 1) }),
    );
    expect(decision.path).toBe('cold_continuation');
    expect(decision.reasonCode).toBe('runner_not_holding_transcript');
  });

  // Cloud runner park (docs/design/cloudflare-sandbox-runner.md, Phase 2): the
  // container is gone, so no sync can be fresh; the park bundle holds the
  // transcript instead, until parkedUntil.
  it('a parked worker satisfies G2 while parkedUntil is in the future, however stale its sync', () => {
    const decision = evaluateAnswerPath(eligible({
      workerUpdatedAt: new Date(NOW - 6 * 60 * 60 * 1000),
      parkedUntil: new Date(NOW + 60_000),
    }));
    expect(decision.path).toBe('resume');
    expect(decision.reasonCode).toBe('resume_eligible');
  });

  it('an expired or absent park falls back to the freshness rule', () => {
    const stale = new Date(NOW - RESUME_RUNNER_FRESH_MS - 1);
    expect(evaluateAnswerPath(eligible({ workerUpdatedAt: stale, parkedUntil: new Date(NOW) })).reasonCode)
      .toBe('runner_not_holding_transcript');
    expect(evaluateAnswerPath(eligible({ workerUpdatedAt: stale, parkedUntil: null })).reasonCode)
      .toBe('runner_not_holding_transcript');
    expect(evaluateAnswerPath(eligible({ workerUpdatedAt: null, parkedUntil: new Date(NOW - 1) })).reasonCode)
      .toBe('runner_not_holding_transcript');
  });

  it('a park does not bypass the other gates (G1 parked status, G3 ack)', () => {
    const parked = { workerUpdatedAt: null, parkedUntil: new Date(NOW + 60_000) };
    expect(evaluateAnswerPath(eligible({ ...parked, workerStatus: 'running' })).reasonCode).toBe('worker_not_parked');
    expect(evaluateAnswerPath(eligible({ ...parked, supportsInstructionAck: false })).reasonCode).toBe('runner_cannot_confirm_delivery');
  });

  it('accepts a sync exactly at the freshness boundary', () => {
    const decision = evaluateAnswerPath(
      eligible({ workerUpdatedAt: new Date(NOW - RESUME_RUNNER_FRESH_MS) }),
    );
    expect(decision.path).toBe('resume');
  });

  it('falls back when the worker has never been synced at all', () => {
    const decision = evaluateAnswerPath(eligible({ workerUpdatedAt: null }));
    expect(decision.reasonCode).toBe('runner_not_holding_transcript');
  });

  it('accepts a numeric epoch timestamp as well as a Date', () => {
    const decision = evaluateAnswerPath(eligible({ workerUpdatedAt: NOW - 5_000 }));
    expect(decision.path).toBe('resume');
  });

  // AC-AQR-4 — G3
  it('falls back when the runner cannot confirm delivery', () => {
    const decision = evaluateAnswerPath(eligible({ supportsInstructionAck: false }));
    expect(decision.path).toBe('cold_continuation');
    expect(decision.reasonCode).toBe('runner_cannot_confirm_delivery');
  });

  // AC-AQR-5 — G4
  it('falls back deliberately above the turn ceiling instead of resuming into it', () => {
    const decision = evaluateAnswerPath(eligible({ workerTurns: RESUME_MAX_TURNS + 1 }));
    expect(decision.path).toBe('cold_continuation');
    expect(decision.reasonCode).toBe('context_ceiling');
  });

  it('accepts a worker exactly at the turn ceiling', () => {
    const decision = evaluateAnswerPath(eligible({ workerTurns: RESUME_MAX_TURNS }));
    expect(decision.path).toBe('resume');
  });

  // A permission prompt is not a parked session: the runner's PermissionRequest
  // hook is blocked INSIDE the live session, and the answer resolves that hook.
  // Nothing is resumed, so the transcript size is irrelevant. Sending one cold
  // superseded a live session thousands of turns deep and handed a fresh
  // session a bare "Allow once" it could not act on.
  it('does not apply the turn ceiling to a permission prompt on a live session', () => {
    const decision = evaluateAnswerPath(
      eligible({ workerTurns: RESUME_MAX_TURNS * 20, waitingForType: 'permission' }),
    );
    expect(decision.path).toBe('resume');
    expect(decision.reasonCode).toBe('resume_eligible');
  });

  it('still applies the turn ceiling to a question', () => {
    const decision = evaluateAnswerPath(
      eligible({ workerTurns: RESUME_MAX_TURNS + 1, waitingForType: 'question' }),
    );
    expect(decision.reasonCode).toBe('context_ceiling');
  });

  it.each([
    [{ workerStatus: 'failed' }, 'worker_not_parked'],
    [{ workerUpdatedAt: null }, 'runner_not_holding_transcript'],
    [{ supportsInstructionAck: false }, 'runner_cannot_confirm_delivery'],
    [{ credentialPreflight: 'unhealthy' as const }, 'credential_unhealthy'],
  ] as const)('keeps every other gate for a permission prompt (%p)', (override, reason) => {
    const decision = evaluateAnswerPath(
      eligible({ ...override, workerTurns: RESUME_MAX_TURNS + 1, waitingForType: 'permission' }),
    );
    expect(decision.reasonCode).toBe(reason);
  });

  it('treats an unknown turn count as zero rather than as over the ceiling', () => {
    const decision = evaluateAnswerPath(eligible({ workerTurns: null }));
    expect(decision.path).toBe('resume');
  });

  // AC-AQR-6 — G5
  it('falls back when the backend credential preflight reports unhealthy', () => {
    const decision = evaluateAnswerPath(eligible({ credentialPreflight: 'unhealthy' }));
    expect(decision.path).toBe('cold_continuation');
    expect(decision.reasonCode).toBe('credential_unhealthy');
  });

  // AC-AQR-8 — absence is not breakage
  it('resumes when no managed credential row exists (preflight unknown)', () => {
    const decision = evaluateAnswerPath(eligible({ credentialPreflight: 'unknown' }));
    expect(decision.path).toBe('resume');
  });

  // AC-AQR-7 — fixed gate order, so the recorded reason is stable
  it('reports the most fundamental failing gate when several fail at once', () => {
    const decision = evaluateAnswerPath(
      eligible({
        workerStatus: 'error',
        workerTurns: RESUME_MAX_TURNS + 500,
        supportsInstructionAck: false,
        credentialPreflight: 'unhealthy',
        workerUpdatedAt: new Date(NOW - 10 * RESUME_RUNNER_FRESH_MS),
      }),
    );
    expect(decision.reasonCode).toBe('worker_not_parked');
  });

  it('reports transcript locality ahead of confirmability, ceiling and credential', () => {
    const decision = evaluateAnswerPath(
      eligible({
        workerUpdatedAt: new Date(NOW - 10 * RESUME_RUNNER_FRESH_MS),
        supportsInstructionAck: false,
        workerTurns: RESUME_MAX_TURNS + 500,
        credentialPreflight: 'unhealthy',
      }),
    );
    expect(decision.reasonCode).toBe('runner_not_holding_transcript');
  });

  it('every reason code carries prose from the closed set', () => {
    for (const code of Object.keys(ANSWER_PATH_REASONS)) {
      expect(typeof ANSWER_PATH_REASONS[code as keyof typeof ANSWER_PATH_REASONS]).toBe('string');
      expect(ANSWER_PATH_REASONS[code as keyof typeof ANSWER_PATH_REASONS].length).toBeGreaterThan(0);
    }
  });

  it('defaults `now` to the current clock when omitted', () => {
    const decision = evaluateAnswerPath({
      workerStatus: 'waiting_input',
      workerUpdatedAt: new Date(),
      workerTurns: 1,
      supportsInstructionAck: true,
      credentialPreflight: 'ok',
    });
    expect(decision.path).toBe('resume');
  });
});

describe('describeAnswerPath', () => {
  it('names the resumed session without a reason clause', () => {
    const line = describeAnswerPath(evaluateAnswerPath(eligible()));
    expect(line).toContain('Resumed');
    expect(line).not.toContain('because');
  });

  it('names the fallback and why it happened', () => {
    const line = describeAnswerPath(
      evaluateAnswerPath(eligible({ supportsInstructionAck: false })),
    );
    expect(line).toContain('continuation');
    expect(line).toContain(ANSWER_PATH_REASONS.runner_cannot_confirm_delivery);
  });
});

describe('buildAnswerDeliveryRecord', () => {
  it('records path, reason code, prose and the worker it decided about', () => {
    const record = buildAnswerDeliveryRecord({
      decision: evaluateAnswerPath(eligible()),
      workerId: 'worker-1',
      question: 'Which database?',
      now: NOW,
    });
    expect(record).toMatchObject({
      path: 'resume',
      reasonCode: 'resume_eligible',
      workerId: 'worker-1',
      question: 'Which database?',
    });
    expect(record.decidedAt).toBe(new Date(NOW).toISOString());
  });

  it('sets an acknowledgement deadline only on the resume path', () => {
    const resumed = buildAnswerDeliveryRecord({
      decision: evaluateAnswerPath(eligible()),
      workerId: 'w',
      question: 'q',
      now: NOW,
    });
    expect(resumed.ackDeadlineAt).toBe(new Date(NOW + RESUME_ACK_DEADLINE_MS).toISOString());

    const cold = buildAnswerDeliveryRecord({
      decision: evaluateAnswerPath(eligible({ supportsInstructionAck: false })),
      workerId: 'w',
      question: 'q',
      now: NOW,
    });
    expect(cold.ackDeadlineAt).toBeUndefined();
  });

  it('omits the question entirely when it was redacted away', () => {
    const record = buildAnswerDeliveryRecord({
      decision: evaluateAnswerPath(eligible()),
      workerId: 'w',
      question: null,
      now: NOW,
    });
    expect('question' in record).toBe(false);
  });
});

describe('buildContinuationDescription', () => {
  const base = {
    taskDescription: 'Fix the auth bug',
    milestones: [{ label: 'Read the route', timestamp: 1 }, { type: 'status', timestamp: 2 }],
    question: 'Which database?',
    answer: 'Postgres',
  };

  it('carries the original task, milestones, question and answer verbatim', () => {
    const description = buildContinuationDescription(base);
    expect(description).toContain('Fix the auth bug');
    expect(description).toContain('Read the route');
    expect(description).toContain('Which database?');
    expect(description).toContain('Postgres');
  });

  it('falls back to a placeholder when no milestone survived redaction', () => {
    const description = buildContinuationDescription({ ...base, milestones: [] });
    expect(description).toContain('No milestones recorded');
  });

  it('uses a milestone type when a sensitive workspace stripped the label', () => {
    const description = buildContinuationDescription({
      ...base,
      milestones: [{ type: 'phase', timestamp: 1 }],
    });
    expect(description).toContain('phase');
  });

  it('tolerates a task with no description', () => {
    const description = buildContinuationDescription({ ...base, taskDescription: null });
    expect(description).toContain('Which database?');
  });
});

// The rejection a stale card gets. The raw gate text ("Worker is not waiting
// for input") told the reader nothing: not why, not what to do next.
describe('explainNotWaiting', () => {
  it('points at the continuation when the question was already answered', () => {
    const r = explainNotWaiting({ workerStatus: 'superseded', continuationTaskId: 'task-2' });
    expect(r.reasonCode).toBe('already_answered');
    expect(r.nextAction).toEqual({ kind: 'open_task', taskId: 'task-2' });
    expect(r.message).not.toMatch(/waitingFor|not waiting for input/i);
  });

  it('asks for a refresh when an answered worker has no recorded continuation', () => {
    const r = explainNotWaiting({ workerStatus: 'superseded', continuationTaskId: null });
    expect(r.reasonCode).toBe('already_answered');
    expect(r.nextAction).toEqual({ kind: 'refresh' });
  });

  it.each([['completed'], ['failed'], ['error']])('says a %s worker has stopped and offers a follow-up', (status) => {
    const r = explainNotWaiting({ workerStatus: status, continuationTaskId: null });
    expect(r.reasonCode).toBe('worker_ended');
    expect(r.nextAction).toEqual({ kind: 'follow_up' });
  });

  it.each([['running'], ['waiting_input'], ['idle'], [null]])('says a %p worker moved on', (status) => {
    const r = explainNotWaiting({ workerStatus: status as string | null, continuationTaskId: null });
    expect(r.reasonCode).toBe('no_longer_waiting');
    expect(r.nextAction).toEqual({ kind: 'refresh' });
  });

  it('every reason carries plain-language prose', () => {
    for (const status of ['superseded', 'failed', 'running']) {
      const r = explainNotWaiting({ workerStatus: status, continuationTaskId: null });
      expect(r.message.length).toBeGreaterThan(20);
    }
  });
});

describe('isAnswerableWaitingFor', () => {
  const permission = { type: 'permission', prompt: 'Permission required for Bash: ls' };
  const question = { type: 'question', prompt: 'Which database?' };

  it('shows nothing without a waitingFor', () => {
    expect(isAnswerableWaitingFor('waiting_input', null)).toBe(false);
  });

  it('shows a permission prompt only while the session is parked on it', () => {
    expect(isAnswerableWaitingFor('waiting_input', permission)).toBe(true);
  });

  // The permission hook is resolved (deny) the moment the session ends, so a
  // prompt still carried by an ended worker grants nothing if answered.
  it.each([['failed'], ['error'], ['completed'], ['superseded'], ['running']])(
    'hides a permission prompt carried by a %s worker',
    (status) => {
      expect(isAnswerableWaitingFor(status, permission)).toBe(false);
    },
  );

  // A question is different: an AskUserQuestion abort legitimately leaves
  // status=error with the question open, and answering it is the whole point.
  it.each([['error'], ['failed'], ['waiting_input']])('keeps a question on a %s worker', (status) => {
    expect(isAnswerableWaitingFor(status, question)).toBe(true);
  });
});

describe('buildContinuationTaskValues: runner preference', () => {
  const args = {
    workspaceId: 'ws-1', workerId: 'w-1', branch: 'buildd/x', milestones: [], question: 'q', answer: 'a',
    delivery: { path: 'cold_continuation', reasonCode: 'worker_not_parked', reason: 'r', workerId: 'w-1', decidedAt: new Date(0).toISOString() } as any,
  };

  it.each(['user', 'service', 'action', 'any'] as const)('carries the parent preference %s', (runnerPreference) => {
    expect(buildContinuationTaskValues({ ...args, task: { id: 't', runnerPreference } }).runnerPreference).toBe(runnerPreference);
  });

  it('no parent preference leaves the column default', () => {
    expect(buildContinuationTaskValues({ ...args, task: { id: 't' } }).runnerPreference).toBeUndefined();
    expect(buildContinuationTaskValues({ ...args, task: null }).runnerPreference).toBeUndefined();
  });
});
