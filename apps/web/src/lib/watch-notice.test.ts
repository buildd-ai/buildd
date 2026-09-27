import { describe, it, expect } from 'bun:test';
import { watchEventTypes, watchNotice, watchWhenPhrase } from './watch-notice';

const TASK = '11111111-1111-4111-8111-111111111111';

describe('watchNotice: the sentence a watch posts, in plain words', () => {
  it('a merged PR: "#123 merged." with a link to the PR', () => {
    const n = watchNotice({
      eventType: 'pr.merged',
      payload: { repo: 'acme/widgets', prNumber: 123, title: 'Round currency at checkout', url: 'https://github.com/acme/widgets/pull/123' },
      subjectRef: { type: 'pr', repo: 'acme/widgets', number: 123 },
    });
    expect(n.text).toBe('#123 merged.');
    expect(n.watch).toEqual({
      eventType: 'pr.merged', label: 'PR #123 · acme/widgets', detail: 'Round currency at checkout',
      href: 'https://github.com/acme/widgets/pull/123', linkText: 'Open PR', tone: 'ok',
    });
  });

  it('a PR without a stored url still links to GitHub', () => {
    const n = watchNotice({ eventType: 'pr.ci_failed', payload: { repo: 'acme/widgets', prNumber: 7 }, subjectRef: {} });
    expect(n.text).toBe('CI failed on #7.');
    expect(n.watch.href).toBe('https://github.com/acme/widgets/pull/7');
    expect(n.watch.tone).toBe('bad');
    expect(n.watch.detail).toBeNull();
  });

  it('task events name the task and link to its page', () => {
    const base = { payload: { taskId: TASK, title: 'Checkout rounding' }, subjectRef: { type: 'task', id: TASK } };
    expect(watchNotice({ ...base, eventType: 'task.completed' }).text).toBe('Checkout rounding is done.');
    expect(watchNotice({ ...base, eventType: 'task.failed' }).text).toBe('Checkout rounding failed.');
    const q = watchNotice({ ...base, eventType: 'task.needs_input' });
    expect(q.text).toBe('Checkout rounding needs your answer.');
    expect(q.watch).toMatchObject({ label: 'Task', href: `/app/tasks/${TASK}`, linkText: 'Open task', tone: 'attention' });
  });

  it('a task event with no title (a sensitive workspace omits prose) still reads', () => {
    const n = watchNotice({ eventType: 'task.completed', payload: { taskId: TASK }, subjectRef: { type: 'task', id: TASK } });
    expect(n.text).toBe('The task you watched is done.');
  });

  it('never names a tool, an event id or a route in the sentence', () => {
    for (const eventType of ['pr.merged', 'pr.ci_failed', 'task.completed', 'task.failed', 'task.needs_input']) {
      const n = watchNotice({ eventType, payload: { repo: 'a/b', prNumber: 1, taskId: TASK, title: 'X' }, subjectRef: {} });
      expect(n.text).not.toMatch(/watch|subscription|\.merged|task\.|pr\.|\/api\//);
      expect(n.text).not.toContain('—');
    }
  });
});

describe('watchEventTypes: what a watch listens for', () => {
  it('defaults: a task when it finishes either way, a PR when it merges', () => {
    expect(watchEventTypes('task')).toEqual(['task.completed', 'task.failed']);
    expect(watchEventTypes('pr')).toEqual(['pr.merged']);
  });

  it('maps the words chat uses and drops ones that do not fit the subject', () => {
    expect(watchEventTypes('task', ['needs_input'])).toEqual(['task.needs_input']);
    expect(watchEventTypes('pr', ['merged', 'ci_failed'])).toEqual(['pr.merged', 'pr.ci_failed']);
    expect(watchEventTypes('task', ['merged'])).toEqual([]);
    expect(watchEventTypes('pr', 'ci_failed')).toEqual(['pr.ci_failed']);
  });
});

describe('watchWhenPhrase', () => {
  it('reads as the end of "Tell you when ..."', () => {
    expect(watchWhenPhrase(['task.completed', 'task.failed'])).toBe('it finishes or fails');
    expect(watchWhenPhrase(['pr.merged'])).toBe('it merges');
    expect(watchWhenPhrase(['pr.merged', 'pr.ci_failed'])).toBe('it merges or CI fails');
    expect(watchWhenPhrase(['task.needs_input'])).toBe('it needs your answer');
  });
});
