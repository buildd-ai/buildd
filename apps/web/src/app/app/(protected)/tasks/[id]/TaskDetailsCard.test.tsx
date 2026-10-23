/**
 * Details, open on the page (Navigation: one place per task, R-9; design
 * 6356e80d `phone-task-running`): what the task fixes, what it waits on and
 * blocks by name, and its attempt.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskDetailsCard from './TaskDetailsCard';

describe('TaskDetailsCard', () => {
  const html = renderToStaticMarkup(
    <TaskDetailsCard
      fixes={{ criteria: ['AC-9'], title: 'Cloud runner: deploy from Settings', href: '/app/specs/s1' }}
      waitsOn={[]}
      blocks={[{ id: 't2', title: 'Settings shows each deploy step', href: '/app/tasks/t2' }]}
      attempt="1"
    />,
  );

  it('is a labelled section, not a collapsed disclosure', () => {
    expect(html).toMatch(/^<section aria-label="Details" data-testid="task-details-card"/);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
  });

  it('Fixes: the criterion and the spec by name, linked', () => {
    expect(html).toContain('data-testid="task-fixes"');
    expect(html).toContain('>AC-9<');
    expect(html).toContain('href="/app/specs/s1"');
    expect(html).toContain('Cloud runner: deploy from Settings');
  });

  it('Blocks: each dependent task by name, linked', () => {
    expect(html).toContain('data-testid="task-unblocked"');
    expect(html).toContain('href="/app/tasks/t2"');
    expect(html).toContain('Settings shows each deploy step');
  });

  it('Attempt, and no empty rows', () => {
    expect(html).toMatch(/>Attempt<\/dt><dd[^>]*>1</);
    expect(html).not.toContain('Waits on');
  });

  it('with nothing to say beyond the attempt it still renders the attempt row', () => {
    const bare = renderToStaticMarkup(<TaskDetailsCard fixes={null} waitsOn={[]} blocks={[]} attempt="2 · 14m" />);
    expect(bare).toContain('2 · 14m');
    expect(bare).not.toContain('task-fixes');
    expect(bare).not.toContain('task-unblocked');
  });

  it('a spec path without an id reads as text', () => {
    const path = renderToStaticMarkup(<TaskDetailsCard fixes={{ criteria: [], title: 'docs/specs/task-page.md', href: null }} waitsOn={[{ id: 't0', title: 'Deploy pipeline', href: '/app/tasks/t0' }]} blocks={[]} attempt="1" />);
    expect(path).toContain('docs/specs/task-page.md');
    expect(path).toContain('Waits on');
    expect(path).toContain('Deploy pipeline');
  });
});
