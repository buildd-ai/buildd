import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DispatchSection } from './DispatchSection';
import { dispatchVerdict, emptyTeamHealth, type DispatchHealthInput, type DispatchHealthReport } from '@buildd/core/dispatch-health-report';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

function report(over: Partial<DispatchHealthInput> = {}): DispatchHealthReport {
  const input: DispatchHealthInput = {
    outbox: {
      ...emptyTeamHealth(),
      pending: 3, due: 1, handedOff: 2, unacked: 1, delivered24h: 9,
      deliveredVia: { dispatch: 7, pusher: 2 }, latencyMs: { p50: 812, p95: 4100, samples: 9 },
    },
    workspaces: [{ id: 'w1', name: 'alpha', transport: 'dispatch' }],
    worker: { status: 'reachable', workerConfigured: true, ms: 40 },
    lastRepair: {
      at: new Date(NOW - 20 * 60_000).toISOString(), ok: true,
      reconcile: { checked: 2, republished: 0, projected: 0, fellBack: 0, left: 2, workerErrors: 0 }, reconcileError: null,
    },
    ...over,
  };
  return { generatedAt: new Date(NOW).toISOString(), ...input, ...dispatchVerdict(input, NOW) };
}

const render = (r: DispatchHealthReport | null) => renderToStaticMarkup(<DispatchSection report={r} now={NOW} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('DispatchSection', () => {
  it('renders nothing without a report (the read failed, or no workspaces)', () => {
    expect(render(null)).toBe('');
    expect(render(report({ workspaces: [] }))).toBe('');
  });

  it('healthy: the verdict, counts, routes, latency, Worker and last repair', () => {
    const html = render(report());
    expect(html).toContain('data-testid="health-section-dispatch"');
    const t = text(html);
    expect(t).toContain('Healthy: 9 wakes delivered in 24h, p95 4.1s.');
    expect(html).toMatch(/data-testid="dispatch-verdict"[^>]*data-healthy="true"/);
    expect(t).toContain('Pending 3 1 due, 0 overdue');
    expect(t).toContain('Delivered 24h 9 p50 0.8s, p95 4.1s');
    expect(t).toContain('dispatch 7');
    expect(t).toContain('pusher 2');
    expect(html).toMatch(/data-tone="success" data-testid="dispatch-worker"/);
    expect(t).toContain('Worker reachable');
    expect(t).toContain('Last repair run 20m ago, all teams: checked 2, republished 0, projected 0, taken back 0, left 2, Worker errors 0');
    // Everyone is on dispatch: no kill-switch row.
    expect(html).not.toContain('dispatch-kill-switch');
  });

  it('unhealthy: every problem listed, error tone, Worker unreachable', () => {
    const html = render(report({
      outbox: { ...emptyTeamHealth(), failed24h: 2, orphaned: 1 },
      worker: { status: 'unreachable', error: 'timeout' },
    }));
    expect(html).toMatch(/data-testid="dispatch-verdict"[^>]*data-healthy="false"/);
    const t = text(html);
    expect(t).toContain('Dispatch Worker unreachable (timeout)');
    expect(t).toContain('2 wakes failed in 24h');
    expect(t).toContain('1 handed-off wake over an hour past due with no receipt');
    expect(html).toMatch(/data-tone="error" data-testid="dispatch-worker"/);
  });

  it('names workspaces not on dispatch (the kill switch in use)', () => {
    const t = text(render(report({
      workspaces: [
        { id: 'w1', name: 'alpha', transport: 'dispatch' },
        { id: 'w2', name: 'beta', transport: 'in_app' },
        { id: 'w3', name: 'gamma', transport: 'shadow' },
      ],
    })));
    expect(t).toContain('Not on dispatch');
    expect(t).toContain('beta in app');
    expect(t).toContain('gamma shadow');
  });

  it('no repair run recorded, and no deliveries: says so plainly, no placeholder dash', () => {
    const html = render(report({ outbox: emptyTeamHealth(), lastRepair: null }));
    const t = text(html);
    expect(t).toContain('No repair run recorded.');
    expect(t).toContain('No deliveries in 24h.');
    expect(html).not.toContain('—');
  });

  it('square chrome: no rounded classes', () => {
    expect(render(report())).not.toMatch(/rounded-(?!none)/);
  });
});
