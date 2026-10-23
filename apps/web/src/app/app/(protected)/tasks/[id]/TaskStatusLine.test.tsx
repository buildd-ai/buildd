import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskWaitingLine, TaskDetailsCard, attemptsSummary } from './TaskStatusLine';

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

describe('TaskDetailsCard — shown, not collapsed', () => {
  it('lists Fixes, Waiting on (linked) and Attempts', () => {
    const html = renderToStaticMarkup(<TaskDetailsCard fixes={{ label: 'Image digest, in Cloud runner', href: '/app/specs/s1' }} waitingOn={{ taskId: 'dep', title: 'Mirror the runner image' }} attempts={attemptsSummary(2, '10m')} />);
    expect(html).toContain('data-testid="task-details-card"');
    expect(html).not.toContain('<details');
    for (const label of ['Fixes', 'Waiting on', 'Attempts']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('href="/app/tasks/dep"');
    expect(html).toContain('2, 10m in total');
  });
  it('says nothing when it has nothing to say', () => {
    expect(renderToStaticMarkup(<TaskDetailsCard fixes={null} waitingOn={null} attempts={attemptsSummary(0, null)} />)).toBe('');
  });
});

describe('attemptsSummary', () => {
  it('reads the count and the time spent', () => {
    expect(attemptsSummary(1, '9m')).toBe('1, 9m in total');
    expect(attemptsSummary(3, null)).toBe('3');
    expect(attemptsSummary(0, '9m')).toBeNull();
  });
});
