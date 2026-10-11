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
    expect(html).toMatch(/3<\/b> of 4 busy/);
    expect(html.match(/data-testid="agent-square"/g)).toHaveLength(4);
    expect(html).toContain('data-kind="waiting"');
    expect(html).not.toContain('Steer');
    expect(html).toContain('38m');
    expect(html).toContain('Ship it');
  });

  test('names the longest idle stretch as a caption, with Runners › the one way in', () => {
    const html = renderToStaticMarkup(<AgentsPanel model={model} idle={[{ from: 0, to: 2 * 3_600_000, waited: 3 }]} />);
    expect(html).toContain('idle 2h while 3 tasks waited');
    expect(html.match(/href="\/app\/health\/runners"/g)).toHaveLength(1);
    // The caption is quiet text under the chart, not a second bold link.
    expect(html).toMatch(/<p data-testid="agents-idle"[^>]*text-text-muted/);
  });

  test('each line wears its slot square: the same mark for busy and waiting as the row above', () => {
    const html = renderToStaticMarkup(<AgentsPanel model={model} />);
    const marks = [...html.matchAll(/data-testid="agent-line-square" data-kind="(\w+)"/g)].map(m => m[1]);
    expect(marks).toEqual(['busy', 'waiting']);
    expect(html).not.toContain('▶');
    expect(html).toContain('needs you');
  });

  test('the count sits beside the squares; no runner says so plainly', () => {
    expect(renderToStaticMarkup(<AgentsPanel model={model} />)).toMatch(/<b[^>]*>3<\/b> of 4 busy/);
    const none = renderToStaticMarkup(<AgentsPanel model={{ busy: 0, total: 0, squares: [], lines: [] }} />);
    expect(none).toContain('No runner online');
    expect(none).not.toContain('agent-square');
  });
});
