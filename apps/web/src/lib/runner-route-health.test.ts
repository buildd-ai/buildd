import { describe, it, expect } from 'bun:test';
import { runnerRouteDetail, taskRouteRows } from './runner-route-health';

describe('runnerRouteDetail (capacity spec R-11)', () => {
  it('names the local login type without exposing anything but a label', () => {
    const d = runnerRouteDetail({ modelAuthSource: 'machine_login', codexAuthSource: 'api_key' });
    expect(d.rows[0]).toMatchObject({ label: 'Claude', state: 'ready' });
    expect(d.rows[0].source).toContain('Claude login');
    expect(d.rows[1]).toMatchObject({ label: 'Codex', state: 'ready' });
    expect(d.rows[1].source).toContain('billed per token');
  });

  it('keeps "no login" distinct from "never reported"', () => {
    expect(runnerRouteDetail({ modelAuthSource: 'none' }).rows[0].state).toBe('unavailable');
    expect(runnerRouteDetail({ modelAuthSource: null }).rows[0].state).toBe('unknown');
    expect(runnerRouteDetail({}).rows[1].state).toBe('unknown');
  });

  it('does not claim team key readiness', () => {
    expect(runnerRouteDetail({}).note).toContain('team API key');
  });
});

describe('taskRouteRows (recorded per-task routes)', () => {
  it('names team key, gateway and local plan login apart, with counts', () => {
    const rows = taskRouteRows([
      { route: 'anthropic_api_key', count: 2 },
      { route: 'agent_endpoint', count: 1 },
      { route: 'oauth_seat', count: 3 },
    ]);
    expect(rows.map(r => r.source)).toEqual([
      expect.stringContaining('team API key'),
      expect.stringContaining('team model endpoint'),
      expect.stringContaining('plan login'),
    ]);
    expect(rows.map(r => r.count)).toEqual([2, 1, 3]);
  });

  it('is empty, not a guess, when nothing was recorded, and ignores unknown words', () => {
    expect(taskRouteRows(undefined)).toEqual([]);
    expect(taskRouteRows([{ route: 'something_new', count: 1 }])).toEqual([]);
  });

  it('is carried by the detail beside, not instead of, the local login rows', () => {
    const d = runnerRouteDetail({ modelAuthSource: 'machine_login', recentRoutes: [{ route: 'anthropic_api_key', count: 1 }] });
    expect(d.rows[0].state).toBe('ready');
    expect(d.taskRoutes).toHaveLength(1);
    expect(d.note).not.toContain("isn't shown here");
  });
});
