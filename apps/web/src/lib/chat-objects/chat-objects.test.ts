/**
 * The pure halves of the chat object loaders: PR state, question open/closed
 * shaping, the mission goal line, and the task Now strip gate.
 */
import { describe, it, expect, mock } from 'bun:test';

// The loaders import the db; these tests only exercise pure helpers.
mock.module('@buildd/core/db', () => ({ db: {} }));

const { prStateOf, parsePrRefId } = await import('./load-pr-object');

describe('parsePrRefId', () => {
  it('reads the chat contract PR id and rejects anything else', () => {
    expect(parsePrRefId('harborline/billing-web#413')).toEqual({ repo: 'harborline/billing-web', number: 413 });
    expect(parsePrRefId('billing-web#413')).toBeNull();
    expect(parsePrRefId('a/b#')).toBeNull();
    expect(parsePrRefId('a/b#1; drop')).toBeNull();
  });
});
const { shapeQuestion, askerLabelFor } = await import('./load-question-object');
const { missionGoalLine } = await import('./load-mission-object');
const { taskNowState } = await import('./load-task-object');

describe('prStateOf', () => {
  it('a merge stamp wins over any lifecycle value', () => {
    expect(prStateOf('ci_failed', new Date())).toBe('merged');
    expect(prStateOf(null, '2026-01-01T00:00:00Z')).toBe('merged');
  });

  it('maps each lifecycle status', () => {
    expect(prStateOf('merged', null)).toBe('merged');
    expect(prStateOf('ci_failed', null)).toBe('ci_failed');
    expect(prStateOf('ci_running', null)).toBe('ci_running');
    expect(prStateOf('ci_green', null)).toBe('ci_passed');
    expect(prStateOf('closed', null)).toBe('closed');
    expect(prStateOf('unresolvable', null)).toBe('closed');
    expect(prStateOf('pr_open', null)).toBe('open');
    expect(prStateOf('conflict', null)).toBe('open');
    expect(prStateOf(null, null)).toBe('open');
  });
});

describe('shapeQuestion', () => {
  const waitingFor = { prompt: 'Round per line, or only the total?', options: ['Per line', 'Total only'], type: 'question' };

  it('open: the newest worker holding a waitingFor, unified with its open note', () => {
    const s = shapeQuestion({
      taskTitle: 'feat(checkout): Stripe in currency',
      workers: [{ id: 'w2', waitingFor, updatedAt: '2026-01-01T12:00:00Z' }, { id: 'w1', waitingFor: null }],
      notes: [
        { id: 'n0', workerId: 'w0', type: 'question', status: 'answered', title: 'Old ask', createdAt: '2026-01-01T10:00:00Z' },
        { id: 'n1', workerId: 'w2', type: 'question', status: 'open', title: 'Round per line or total?', body: 'Which is the source of truth?', defaultChoice: 'Per line', createdAt: '2026-01-01T11:59:00Z' },
      ],
    });
    expect(s.open).toBe(true);
    expect(s.workerId).toBe('w2');
    expect(s.question.headline).toBe('Round per line or total?');
    expect(s.question.noteId).toBe('n1');
    expect(s.question.options.map(o => o.label)).toEqual(['Per line', 'Total only']);
    expect(s.question.options[0].recommended).toBe(true);
    expect(s.askedAt).toBe(Date.parse('2026-01-01T11:59:00Z'));
    expect(s.answer).toBeNull();
  });

  it('open without a note: the prompt is the headline, asked when the worker last updated', () => {
    const s = shapeQuestion({ taskTitle: 't', workers: [{ id: 'w1', waitingFor, updatedAt: '2026-01-01T12:00:00Z' }], notes: [] });
    expect(s.open).toBe(true);
    expect(s.question.headline).toBe(waitingFor.prompt);
    expect(s.askedAt).toBe(Date.parse('2026-01-01T12:00:00Z'));
  });

  it('closed: the newest question note, with its reply as the answer', () => {
    const s = shapeQuestion({
      taskTitle: 't',
      workers: [{ id: 'w1', waitingFor: null }],
      notes: [{ id: 'n1', type: 'question', status: 'answered', title: 'Round per line or total?', createdAt: '2026-01-01T11:00:00Z' }],
      replies: [{ replyTo: 'other', title: 'nope' }, { replyTo: 'n1', title: 'Per line' }],
    });
    expect(s.open).toBe(false);
    expect(s.workerId).toBe('w1');
    expect(s.question.headline).toBe('Round per line or total?');
    expect(s.answer).toBe('Per line');
  });

  it('closed with no note: falls back to the task title', () => {
    const s = shapeQuestion({ taskTitle: 'feat(api): currency on API', workers: [], notes: [] });
    expect(s.open).toBe(false);
    expect(s.workerId).toBeNull();
    expect(s.question.headline).toBe('feat(api): currency on API');
    expect(s.answer).toBeNull();
  });

  it('asker label from the role name', () => {
    expect(askerLabelFor('Builder')).toBe('The builder asks');
    expect(askerLabelFor(null)).toBe('The agent asks');
  });
});

describe('missionGoalLine', () => {
  it('first paragraph, markdown stripped, whitespace folded', () => {
    expect(missionGoalLine('## Let customers **pay**\nin their currency.\n\nMore detail.')).toBe('Let customers pay in their currency.');
    expect(missionGoalLine(null)).toBeNull();
    expect(missionGoalLine('   ')).toBeNull();
  });
});

describe('taskNowState', () => {
  const now = Date.parse('2026-01-01T12:10:00Z');
  it('null unless the worker is live', () => {
    expect(taskNowState(null, now)).toBeNull();
    expect(taskNowState({ status: 'completed', currentAction: null, prUrl: null, startedAt: now - 60_000, milestones: [] }, now)).toBeNull();
  });

  it('derives the Now strip for a live worker, tolerating a non-array milestones column', () => {
    const s = taskNowState({ status: 'running', currentAction: 'Reading files', prUrl: null, startedAt: now - 60_000, milestones: null }, now);
    expect(s).not.toBeNull();
    expect(Array.isArray(s!.steps)).toBe(true);
  });
});
