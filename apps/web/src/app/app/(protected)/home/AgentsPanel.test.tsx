import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentsPanel } from './AgentsPanel';
import type { AgentsModel } from '@/lib/home-agents';

const model: AgentsModel = {
  busy: 3, total: 4, squares: ['busy', 'waiting', 'busy', 'free'],
  lines: [
    { key: 'a', taskId: 't1', name: 'db', rest: 'add index', missionId: 'm', mission: 'Ship it', href: '/app/tasks/t1', waiting: false, elapsedMs: 38 * 60_000 },
    { key: 'b', taskId: 't2', name: 'api', rest: '', missionId: null, mission: null, href: null, waiting: true, elapsedMs: 5 * 60_000 },
  ],
};

describe('AgentsPanel', () => {
  test('summary, one square per slot, no runner or role', () => {
    const html = renderToStaticMarkup(<AgentsPanel model={model} />);
    expect(html).toContain('3 of 4 busy');
    expect(html.match(/data-testid="agent-square"/g)).toHaveLength(4);
    expect(html).toContain('data-kind="waiting"');
    expect(html).not.toContain('Steer');
    expect(html).toContain('38m');
    expect(html).toContain('Ship it');
  });

  test('names the longest idle stretch and links it to Health › Runners', () => {
    const html = renderToStaticMarkup(<AgentsPanel model={model} idle={[{ from: 0, to: 2 * 3_600_000, waited: 3 }]} />);
    expect(html).toContain('idle 2h while 3 tasks waited');
    expect(html).toContain('href="/app/health/runners"');
  });
});
