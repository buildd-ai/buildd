import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentsPanel } from './AgentsPanel';
import type { AgentsModel } from '@/lib/home-agents';
import { buildOccupancySeries } from '@/lib/fleet-occupancy';

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
    expect(html).toContain('waiting on you');
  });

  describe('idle', () => {
    const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
    const H = 3_600_000;
    const idleModel: AgentsModel = { busy: 0, total: 4, squares: ['free', 'free', 'free', 'free'], lines: [] };
    const quietDay = buildOccupancySeries({ window: '24h', now: NOW, workers: [] });
    const busyDay = buildOccupancySeries({
      window: '24h', now: NOW,
      workers: [{ runner: 'http://r', status: 'completed', startedAt: NOW - 5 * H, completedAt: NOW - 3 * H, updatedAt: null }],
    });
    const stretch = [{ from: NOW - 10 * H, to: NOW - 8 * H, waited: 3 }];

    test('a completely idle day is one quiet row: no plot, no second "nothing running" line', () => {
      const html = renderToStaticMarkup(<AgentsPanel model={idleModel} occupancy={quietDay} />);
      expect(html).toMatch(/<b[^>]*>0<\/b> of 4 busy/);
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('occupancy-sparkline');
      expect(html).toContain('No runner work in the past 24h');
      expect(html).not.toContain('No agents running');
      expect(html.match(/href="\/app\/health\/runners"/g)).toHaveLength(1);
    });

    test('an idle day where work waited keeps the queued-work fact, without the empty plot or its swatch', () => {
      const html = renderToStaticMarkup(<AgentsPanel model={idleModel} occupancy={quietDay} idle={stretch} />);
      expect(html).not.toContain('<svg');
      expect(html).toContain('No runner work in the past 24h');
      expect(html).toContain('idle 2h while 3 tasks waited');
      expect(html).not.toContain('--q-tint');
    });

    test('idle now but busy earlier keeps the chart, and the count alone says nothing is running', () => {
      const html = renderToStaticMarkup(<AgentsPanel model={idleModel} occupancy={busyDay} idle={stretch} />);
      expect(html).toContain('<svg');
      expect(html).toContain('Past 24h · Peak 1');
      expect(html).toContain('idle 2h while 3 tasks waited');
      expect(html).not.toContain('No agents running');
    });
  });

  test('the count sits beside the squares; no runner says so plainly', () => {
    expect(renderToStaticMarkup(<AgentsPanel model={model} />)).toMatch(/<b[^>]*>3<\/b> of 4 busy/);
    const none = renderToStaticMarkup(<AgentsPanel model={{ busy: 0, total: 0, squares: [], lines: [] }} />);
    expect(none).toContain('No runner online');
    expect(none).not.toContain('agent-square');
  });
});
