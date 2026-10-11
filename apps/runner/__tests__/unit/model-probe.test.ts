import { describe, it, expect, mock } from 'bun:test';
import { ModelProbePoller, type ModelProbeApi } from '../../src/model-probe';

function setup(opts: { lease?: { model: string | null; leaseId?: string }; probe?: { ok: boolean; error?: string } | Error } = {}) {
  let t = 1_000_000;
  const reports: any[] = [];
  const api: ModelProbeApi = {
    lease: mock(async () => opts.lease ?? { model: null }),
    report: mock(async (r) => { reports.push(r); }),
  };
  const probe = mock(async () => {
    if (opts.probe instanceof Error) throw opts.probe;
    return opts.probe ?? { ok: true };
  });
  const poller = new ModelProbePoller({ api, probe, cliVersion: () => '2.1.290', now: () => t, intervalMs: 1000 });
  return { poller, api, probe, reports, advance: (ms: number) => { t += ms; } };
}

describe('ModelProbePoller', () => {
  it('does nothing when the server has nothing to certify', async () => {
    const { poller, probe } = setup();
    expect(await poller.poll()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes a leased model and reports success with its CLI version', async () => {
    const { poller, reports } = setup({ lease: { model: 'claude-haiku-5-5', leaseId: 'l1' } });
    expect(await poller.poll()).toBe(true);
    expect(reports).toEqual([{ model: 'claude-haiku-5-5', leaseId: 'l1', cliVersion: '2.1.290', ok: true, error: null }]);
  });

  it('reports the provider error verbatim, including a thrown one', async () => {
    const msg = 'Claude Code 2.1.290 does not support this model; version 2.1.295 or newer is required.';
    const { poller, reports } = setup({ lease: { model: 'claude-haiku-5-5', leaseId: 'l1' }, probe: new Error(msg) });
    await poller.poll();
    expect(reports[0]).toMatchObject({ ok: false, error: msg });
  });

  it('asks at most once per interval and never when disabled', async () => {
    const s = setup({ lease: { model: 'claude-haiku-5-5', leaseId: 'l1' } });
    await s.poller.poll();
    await s.poller.poll();
    expect(s.api.lease).toHaveBeenCalledTimes(1);
    s.advance(1001);
    await s.poller.poll();
    expect(s.api.lease).toHaveBeenCalledTimes(2);

    const off = new ModelProbePoller({ api: s.api, probe: s.probe, cliVersion: () => '2.1.290', enabled: false });
    expect(await off.poll()).toBe(false);
  });

  it('a server failure never throws out of poll', async () => {
    const api: ModelProbeApi = { lease: async () => { throw new Error('HTTP 500'); }, report: async () => {} };
    const poller = new ModelProbePoller({ api, probe: async () => ({ ok: true }), cliVersion: () => '2.1.290' });
    expect(await poller.poll()).toBe(false);
  });
});
