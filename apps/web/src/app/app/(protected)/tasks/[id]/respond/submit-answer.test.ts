/**
 * The submit handler every answer surface shares. The live bug: the first tap
 * landed, the card said nothing, and the second tap came back "already
 * answered" and read as a failure. A duplicate is an answer on record.
 */
import { describe, expect, it, mock } from 'bun:test';
import { AnswerSubmitError, answerOutcomeLines, classifyRespondReply, staleAnswerNotice, submitAnswer } from './submit-answer';

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('classifyRespondReply', () => {
  it('maps a 200 to sent, with where the work now is', () => {
    const o = classifyRespondReply(200, { path: 'resume', taskId: 't1', message: 'Resumed.' }, 'Park and wait');
    expect(o).toEqual({ kind: 'sent', answer: 'Park and wait', taskId: 't1', path: 'resume', message: 'Resumed.' });
  });

  it('maps a 409 already-answered to the answered state, not an error', () => {
    const o = classifyRespondReply(409, { error: 'Question was already answered', reasonCode: 'already_answered', recordedAnswer: 'Park and wait' }, 'Park and wait');
    expect(o.kind).toBe('already_answered');
    if (o.kind !== 'already_answered') throw new Error('unreachable');
    expect(o.recordedAnswer).toBe('Park and wait');
    expect(o.differs).toBe(false);
  });

  it('maps a 409 from a server that predates the reason code', () => {
    expect(classifyRespondReply(409, { error: 'Question was already answered' }, 'x').kind).toBe('already_answered');
  });

  it('maps the stale-card 400 with reason already_answered too', () => {
    const o = classifyRespondReply(400, { error: 'This was already answered.', reasonCode: 'already_answered', recordedAnswer: null }, 'x');
    expect(o.kind).toBe('already_answered');
  });

  it('says when the recorded answer differs from the tap (case and spacing aside)', () => {
    const differs = classifyRespondReply(409, { reasonCode: 'already_answered', recordedAnswer: 'Ship it now' }, 'Park and wait');
    const same = classifyRespondReply(409, { reasonCode: 'already_answered', recordedAnswer: ' park and wait ' }, 'Park and wait');
    expect(differs.kind === 'already_answered' && differs.differs).toBe(true);
    expect(same.kind === 'already_answered' && same.differs).toBe(false);
  });

  it('keeps a revoked-credential 409 an error: the question is still open', () => {
    const o = classifyRespondReply(409, { error: 'Backend credential (claude) is revoked.', credentialRevoked: true }, 'x');
    expect(o).toEqual({ kind: 'error', message: 'Backend credential (claude) is revoked.', credentialRevoked: true });
  });

  it('keeps every other refusal an error', () => {
    expect(classifyRespondReply(400, { reasonCode: 'worker_ended', error: 'This agent has already stopped.' }, 'x').kind).toBe('error');
    expect(classifyRespondReply(500, null, 'x')).toEqual({ kind: 'error', message: 'Failed to send answer', credentialRevoked: false });
  });
});

describe('answerOutcomeLines', () => {
  it('reads "You answered" for a sent answer and for a duplicate of the same one', () => {
    expect(answerOutcomeLines({ kind: 'sent', answer: 'Park and wait', taskId: null, path: null, message: null }).headline).toBe('You answered: Park and wait');
    const dup = answerOutcomeLines({ kind: 'already_answered', answer: 'Park and wait', recordedAnswer: 'Park and wait', differs: false, taskId: null, path: null, message: null });
    expect(dup).toEqual({ headline: 'You answered: Park and wait', detail: null });
  });

  it('names the recorded answer and the tap that was not sent when they differ', () => {
    const l = answerOutcomeLines({ kind: 'already_answered', answer: 'Park and wait', recordedAnswer: 'Ship it', differs: true, taskId: null, path: null, message: null });
    expect(l.headline).toBe('Already answered: Ship it');
    expect(l.detail).toContain('Park and wait');
  });

  it('never reads as an error when the recorded text is unknown', () => {
    const l = answerOutcomeLines({ kind: 'already_answered', answer: 'x', recordedAnswer: null, differs: false, taskId: null, path: null, message: null });
    expect(l.headline).toBe('Already answered');
    expect(`${l.headline} ${l.detail}`).not.toMatch(/error|failed/i);
  });
});

describe('submitAnswer', () => {
  it('resolves (does not throw) on 409 already answered, and does not mark the note with the losing text', async () => {
    const calls: string[] = [];
    const fetchImpl = mock(async (url: string) => {
      calls.push(url);
      return reply(409, { error: 'Question was already answered', reasonCode: 'already_answered', recordedAnswer: 'Park and wait' });
    });
    const o = await submitAnswer({ workerId: 'w1', taskId: 't1', noteId: 'n1', message: 'Park and wait' }, fetchImpl as unknown as typeof fetch);
    expect(o.kind).toBe('already_answered');
    expect(calls).toEqual(['/api/workers/w1/respond']);
  });

  it('marks the question note on a sent answer', async () => {
    const calls: string[] = [];
    const fetchImpl = mock(async (url: string) => {
      calls.push(url);
      return reply(200, { path: 'resume', taskId: 't1' });
    });
    const o = await submitAnswer({ workerId: 'w1', taskId: 't1', noteId: 'n1', message: 'Park and wait' }, fetchImpl as unknown as typeof fetch);
    expect(o.kind).toBe('sent');
    expect(calls).toEqual(['/api/workers/w1/respond', '/api/tasks/t1/notes/n1/reply']);
  });

  it('throws an AnswerSubmitError on a real failure, carrying a revoked credential', async () => {
    const fetchImpl = mock(async () => reply(409, { error: 'revoked', credentialRevoked: true }));
    const err = await submitAnswer({ workerId: 'w1', message: 'x' }, fetchImpl as unknown as typeof fetch).catch(e => e);
    expect(err).toBeInstanceOf(AnswerSubmitError);
    expect(err.credentialRevoked).toBe(true);
  });

  it('throws a retryable error when the network drops', async () => {
    const fetchImpl = mock(async () => { throw new TypeError('Failed to fetch'); });
    const err = await submitAnswer({ workerId: 'w1', message: 'x' }, fetchImpl as unknown as typeof fetch).catch(e => e);
    expect(err).toBeInstanceOf(AnswerSubmitError);
    expect(err.message).toMatch(/did not send/i);
  });
});

// What a stale card shows when /respond says nothing is waiting any more.
describe('staleAnswerNotice', () => {
  it('links an already-answered question to its continuation', () => {
    expect(staleAnswerNotice({
      error: 'This was already answered, and the work moved to a follow-up task.',
      reasonCode: 'already_answered',
      nextAction: { kind: 'open_task', taskId: 'task-2' },
    }, 'task-1')).toEqual({
      message: 'This was already answered, and the work moved to a follow-up task.',
      href: '/app/tasks/task-2',
      linkLabel: 'Open the follow-up task',
    });
  });

  it('sends an ended worker to its own task page to retry or follow up', () => {
    const notice = staleAnswerNotice({ error: 'This agent has already stopped.', reasonCode: 'worker_ended', nextAction: { kind: 'follow_up' } }, 'task-1');
    expect(notice?.href).toBe('/app/tasks/task-1');
    expect(notice?.linkLabel).toMatch(/retry|follow-up/i);
  });

  it('offers no link when a refresh is all it takes', () => {
    const notice = staleAnswerNotice({ error: 'The agent moved on.', reasonCode: 'no_longer_waiting', nextAction: { kind: 'refresh' } }, 'task-1');
    expect(notice).toEqual({ message: 'The agent moved on.', href: null, linkLabel: null });
  });

  it('is null for any other rejection, which keeps the question open', () => {
    expect(staleAnswerNotice({ error: 'Backend credential (claude) is revoked.', credentialRevoked: true }, 'task-1')).toBeNull();
    expect(staleAnswerNotice(null, 'task-1')).toBeNull();
  });
});

describe('submitAnswer on a stale card', () => {
  it('carries the stale notice on the error, with the follow-up link', async () => {
    const fetchImpl = mock(async () => reply(400, { error: 'This agent has already stopped.', reasonCode: 'worker_ended', nextAction: { kind: 'follow_up' } }));
    const err = await submitAnswer({ workerId: 'w1', taskId: 't1', message: 'x' }, fetchImpl as unknown as typeof fetch).catch(e => e);
    expect(err).toBeInstanceOf(AnswerSubmitError);
    expect(err.stale).toEqual({ message: 'This agent has already stopped.', href: '/app/tasks/t1', linkLabel: 'Retry or start a follow-up from this task' });
  });

  it('has no stale notice on an error that leaves the question open', async () => {
    const fetchImpl = mock(async () => reply(500, { error: 'Failed to record response' }));
    const err = await submitAnswer({ workerId: 'w1', taskId: 't1', message: 'x' }, fetchImpl as unknown as typeof fetch).catch(e => e);
    expect(err.stale).toBeNull();
  });
});

describe('classifyRespondReply: an earlier answer moved the work', () => {
  it('names the follow-up task an already-answered question went to', () => {
    const o = classifyRespondReply(409, { reasonCode: 'already_answered', recordedAnswer: 'Ship it', nextAction: { kind: 'open_task', taskId: 't2' } }, 'Ship it');
    expect(o.kind === 'already_answered' && o.followUpTaskId).toBe('t2');
  });
});
