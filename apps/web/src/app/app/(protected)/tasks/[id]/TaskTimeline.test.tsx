import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskTimeline from './TaskTimeline';
import { buildTaskTimeline } from '@/lib/task-timeline';

it('renders a stopped build before verification and nests the repair link under its cause', () => {
  const groups = buildTaskTimeline({ task: { status: 'completed' }, kind: 'landed', workers: [{ id: 'build', status: 'completed' }], lineage: [{ kind: 'ci_failed', title: 'CI failed', sub: 'Tests', at: null }, { kind: 'attempt', n: 2, title: 'CI fix 1', sub: 'CI passed', at: null }, { kind: 'merged', title: 'Merged', sub: '', at: null }], ciAttemptTasks: [{ id: 'repair', status: 'completed' }] });
  const html = renderToStaticMarkup(<TaskTimeline groups={groups} />);
  expect(html.indexOf('>Build</h2>')).toBeLessThan(html.indexOf('>Verify</h2>'));
  expect(html.indexOf('CI failed')).toBeLessThan(html.indexOf('href="/app/tasks/repair"'));
  expect(html).toContain('Fix 1');
  expect(html.indexOf('Fix 1')).toBeLessThan(html.indexOf('>Deliver</h2>'));
});
it('renders nothing before there are any recorded events', () => {
  expect(renderToStaticMarkup(<TaskTimeline groups={[]} />)).toBe('');
});
