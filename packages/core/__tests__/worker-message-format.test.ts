/**
 * Rendering tests for worker→worker messages. Pure — no db, no mocks.
 *
 * Two things these guard, both of which shipped wrong once:
 *  - `path_released` used to say "merged … rebase" unconditionally, but claims
 *    are also released when a worker fails, when a PR is closed unmerged, and
 *    by the reaper — and on the happy path BEFORE the PR merges. Telling a
 *    waiter to rebase onto work that never landed is worse than silence.
 *  - the reply recipe used to render params that fail send_worker_message's
 *    schema, so an agent following it verbatim could not answer at all.
 */

import { describe, it, expect } from 'bun:test';
import { formatWorkerMessages, type WorkerMessage } from '../worker-message-format';

function released(reason?: string): WorkerMessage {
  return {
    id: 'msg-1',
    type: 'path_released',
    fromTaskId: 'task-holder',
    sentAt: '2026-09-05T00:00:00.000Z',
    hopCount: 0,
    body: {
      paths: ['packages/core/db/schema.ts'],
      releasedAt: '2026-09-05T00:00:00.000Z',
      ...(reason ? { reason } : {}),
    },
  };
}

describe('path_released rendering', () => {
  it('tells a waiter to rebase only when the work actually merged', () => {
    const out = formatWorkerMessages([released('merged')]);
    expect(out).toContain('packages/core/db/schema.ts');
    expect(out).toMatch(/rebase/i);
  });

  it('does NOT say merged or rebase when the PR is still open', () => {
    const out = formatWorkerMessages([released('pending_merge')]);
    expect(out).toMatch(/NOT merged/i);
    expect(out).toMatch(/do NOT rebase/i);
  });

  it('says nothing landed when the holder was abandoned', () => {
    const out = formatWorkerMessages([released('abandoned')]);
    expect(out).toMatch(/without merging/i);
    expect(out).toMatch(/do NOT rebase/i);
    expect(out).toMatch(/absent/i);
  });

  it('degrades to "confirm before you rebase" when the reason is missing', () => {
    const out = formatWorkerMessages([released()]);
    expect(out).toMatch(/unknown/i);
    expect(out).not.toMatch(/Your base moved/i);
  });
});

describe('reply recipe', () => {
  const question: WorkerMessage = {
    id: 'msg-7',
    type: 'question',
    fromTaskId: 'task-sender',
    sentAt: '2026-09-05T00:00:00.000Z',
    hopCount: 2,
    body: { text: 'Are you regenerating the drizzle journal?' },
  };

  it('renders a call that satisfies the tool schema', () => {
    const out = formatWorkerMessages([question]);
    // required by the schema, and previously absent
    expect(out).toContain('recipientTaskId: "task-sender"');
    // replyToMsgId belongs INSIDE body, not at the top level
    expect(out).toMatch(/body:\s*\{[^}]*replyToMsgId: "msg-7"/);
    expect(out).not.toMatch(/type: "answer", replyToMsgId/);
  });

  it('echoes hopCount so the loop cap keeps counting', () => {
    const out = formatWorkerMessages([question]);
    expect(out).toContain('hopCount: 2');
  });
});


describe('duplicate deliveries', () => {
  it('renders a message id once even if it was queued twice', () => {
    const out = formatWorkerMessages([released('merged'), released('merged')]);
    expect(out.match(/AGENT MESSAGE/g)?.length).toBe(1);
  });
});

describe('backward compatibility with removed message types', () => {
  it('old path_blocked_on_you message still formats as plain text without throwing', () => {
    const out = formatWorkerMessages([{
      id: 'msg-8',
      type: 'path_blocked_on_you' as any,
      fromTaskId: 'task-detector',
      sentAt: '2026-09-05T00:00:00.000Z',
      hopCount: 0,
      body: { overlappingPaths: ['apps/web/src/lib/foo.ts'], detectedByBranch: 'buildd/abc' },
    }]);
    expect(out).toBeTruthy();
    expect(out).toContain('AGENT MESSAGE');
  });
});

// /respond's interactive path: a person answering the session's own ask_human
// question. It must not read as another agent's message.
describe('human answer rendering', () => {
  const answer = (body: Record<string, unknown>): WorkerMessage => ({
    id: 'msg-a',
    type: 'answer',
    fromTaskId: 'task-self',
    toTaskId: 'task-self',
    fromWorkerId: null,
    sentAt: '2026-09-05T00:00:00.000Z',
    hopCount: 0,
    body,
  });

  it('names it a human answer to your question, with the question and the answer', () => {
    const out = formatWorkerMessages([answer({ source: 'human', text: 'Use JWT', question: 'Which auth?' })]);
    expect(out).toContain('HUMAN ANSWER');
    expect(out).toContain('Which auth?');
    expect(out).toContain('Use JWT');
    expect(out).not.toContain('AGENT MESSAGE');
  });

  it('renders without the question when it was withheld', () => {
    const out = formatWorkerMessages([answer({ source: 'human', text: 'Use JWT' })]);
    expect(out).toContain('HUMAN ANSWER');
    expect(out).toContain('Use JWT');
  });

  it('an agent answer still renders as an agent message', () => {
    const out = formatWorkerMessages([answer({ text: 'I land it in 5m' })]);
    expect(out).toContain('AGENT MESSAGE');
  });
});

describe('describeInjectedMessage: who a follow-up came from', () => {
  const { describeInjectedMessage } = require('../worker-message-format') as typeof import('../worker-message-format');

  it('names a rendered agent message as an agent message, with its type and sender', () => {
    const text = formatWorkerMessages([released('merged')]);
    expect(describeInjectedMessage(text)).toEqual({ source: 'agent', label: 'Agent message: path released, from task task-hol' });
  });

  it('keeps several batched agent messages as one agent message', () => {
    const text = formatWorkerMessages([released('merged'), { ...released('abandoned'), id: 'msg-2' }]);
    expect(describeInjectedMessage(text).source).toBe('agent');
  });

  it('treats anything else as a person, without guessing', () => {
    expect(describeInjectedMessage('also update the docs')).toEqual({ source: 'user', label: 'User: also update the docs' });
  });

  it('does not call a person\'s text an agent message just because it mentions the marker mid-line', () => {
    expect(describeInjectedMessage('why does it say **AGENT MESSAGE** here?').source).toBe('user');
  });

  it('truncates a long person message', () => {
    expect(describeInjectedMessage('x'.repeat(100)).label).toBe(`User: ${'x'.repeat(30)}...`);
  });
});
