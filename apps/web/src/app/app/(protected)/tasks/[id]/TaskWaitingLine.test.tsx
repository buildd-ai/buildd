import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskWaitingLine } from './TaskWaitingLine';

// Surface audit ff33de4d against desktop-task-waiting (R-20, AC-12).
describe('TaskWaitingLine — a waiting task says what it waits on under its title', () => {
  it('names and links the task it waits on, and that it starts by itself', () => {
    const html = renderToStaticMarkup(<TaskWaitingLine on={{ taskId: 'dep', title: 'Mirror the runner image' }} hasRun={false} />);
    expect(html).toContain('data-testid="task-status-line"');
    expect(html).toContain('href="/app/tasks/dep"');
    expect(html).toContain('Mirror the runner image');
    expect(html).toContain('starts by itself when it merges');
  });
  it('a task that already ran starts again', () => {
    expect(renderToStaticMarkup(<TaskWaitingLine on={{ taskId: 'dep', title: 'X' }} hasRun />)).toContain('starts again by itself when it merges');
  });
  it('an untitled blocker still reads as a sentence', () => {
    expect(renderToStaticMarkup(<TaskWaitingLine on={{ taskId: 'dep', title: null }} hasRun={false} />)).toContain('the task it depends on');
  });
});
