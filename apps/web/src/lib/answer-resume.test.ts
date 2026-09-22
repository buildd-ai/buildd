import { describe, it, expect } from 'bun:test';
import {
  evaluateAnswerPath,
  describeAnswerPath,
  buildContinuationDescription,
  buildAnswerDeliveryRecord,
  ANSWER_PATH_REASONS,
  RESUME_RUNNER_FRESH_MS,
  RESUME_MAX_TURNS,
  RESUME_ACK_DEADLINE_MS,
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
