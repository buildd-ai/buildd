import { describe, expect, it } from 'bun:test';
import { isOpenAsk, isOpenQuestionNote } from './open-ask';

describe('task ask liveness', () => {
  it.each(['completed', 'failed', 'cancelled'])('closes a retained ask on a %s task', status => {
    expect(isOpenAsk(status, 'waiting_input')).toBe(false);
    expect(isOpenQuestionNote({ status: 'open', workerId: 'ended' }, status,
      { id: 'ended', status: 'waiting_input' })).toBe(false);
  });
  it.each(['completed', 'failed', 'idle', 'running', 'disconnected'])('does not open an ask for a %s worker', status => {
    expect(isOpenAsk('in_progress', status)).toBe(false);
    expect(isOpenQuestionNote({ status: 'open' }, 'in_progress', { id: 'worker', status })).toBe(false);
  });
  it('requires a task and a waiting worker, and matches the question owner', () => {
    const worker = { id: 'current', status: 'waiting_input' };
    expect(isOpenAsk(null, worker.status)).toBe(false);
    expect(isOpenQuestionNote({ status: 'open' }, 'in_progress', null)).toBe(false);
    expect(isOpenQuestionNote({ status: 'open', workerId: 'previous' }, 'in_progress', worker)).toBe(false);
    expect(isOpenQuestionNote({ status: 'answered', workerId: 'current' }, 'in_progress', worker)).toBe(false);
    expect(isOpenQuestionNote({ status: 'open', workerId: 'current' }, 'in_progress', worker)).toBe(true);
    expect(isOpenQuestionNote({ status: 'open' }, 'in_progress', worker)).toBe(true);
  });
});
