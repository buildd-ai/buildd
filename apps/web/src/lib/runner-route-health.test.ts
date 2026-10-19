import { describe, it, expect } from 'bun:test';
import { recordedRouteRow, runnerRouteDetail } from './runner-route-health';

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

  it('reads the recorded route of recent runs, independent of the local login', () => {
    const d = runnerRouteDetail({ modelAuthSource: 'machine_login', recentCostBasis: ['real', 'real', null, 'unknown'] });
    expect(d.rows[0].source).toContain('plan');
    const r = d.rows.find(x => x.label === 'Charged to')!;
    expect(r.source).toBe('Recent runs: billed per token');
  });

  it('says mixed when both were recorded, and nothing when none was', () => {
    expect(recordedRouteRow(['real', 'virtual'])!.source).toContain('some billed per token');
    expect(recordedRouteRow(['mixed'])!.source).toContain('some billed per token');
    expect(recordedRouteRow(['virtual'])!.source).toContain('plan allowance');
    expect(recordedRouteRow([null, 'unknown'])).toBeNull();
    expect(runnerRouteDetail({}).rows).toHaveLength(2);
  });
});
