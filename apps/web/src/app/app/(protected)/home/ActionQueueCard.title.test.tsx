import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionQueueCard } from './ActionQueueCard';
import type { ActionQueueItem } from '@/lib/action-queue';

const base: ActionQueueItem = {
  subjectKey: 'task:t-1',
  chip: 'APPROVE',
  taskId: 't-1',
  missionId: 'm-1',
  missionTitle: 'Widget Polish',
};

describe('ActionQueueCard — display title and refresh dependency', () => {
  it('shows the short form of a generated title and keeps the full one as the tooltip', () => {
    const html = renderToStaticMarkup(<ActionQueueCard item={{ ...base, taskTitle: 'Ship mission: Widget Polish' }} />);
    expect(html).toContain('>Ship Widget Polish<');
    expect(html).toContain('title="Ship mission: Widget Polish"');
  });

  it('renders an ordinary title untouched and unwrapped', () => {
    const html = renderToStaticMarkup(<ActionQueueCard item={{ ...base, taskTitle: 'fix(deps): pin the widget parser' }} />);
    expect(html).toContain('fix(deps): pin the widget parser');
    expect(html).not.toContain('class="contents"');
  });

  it('names the refresh PR that has to land first, linking to its task', () => {
    const html = renderToStaticMarkup(<ActionQueueCard item={{
      ...base,
      taskTitle: 'Ship mission: Widget Polish',
      refreshFirst: { prNumber: 2002, prUrl: 'https://github.com/org/repo/pull/2002', taskId: 't-refresh', chip: 'MERGE' },
    }} />);
    expect(html).toContain('data-testid="refresh-first"');
    expect(html).toContain('PR #2002');
    expect(html).toContain('t-refresh');
  });
});
