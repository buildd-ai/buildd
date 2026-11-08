import { describe, expect, test } from 'bun:test';
import { newObservationState, startVramSampler, buildModelObservationPayload } from '../../src/model-observation';

describe('runner model observation', () => {
  test('no GPU sampler: stops after the first miss and reports no VRAM', async () => {
    const st = newObservationState({});
    let calls = 0;
    startVramSampler(st, async () => { calls++; return null; });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    const p = buildModelObservationPayload({ observation: st, taskBackend: 'claude' } as any)!;
    expect('peakVramMb' in p).toBe(false);
    st.stopSampler?.();
  });

  test('records the peak and carries a kind label, never a URL', async () => {
    const st = newObservationState({ endpointKind: 'local_loopback', contextWindow: 8192 });
    startVramSampler(st, async () => 4096);
    await new Promise((r) => setTimeout(r, 20));
    const p = buildModelObservationPayload({ observation: st, taskBackend: 'codex' } as any)!;
    expect(p.peakVramMb).toBe(4096);
    expect(p.endpointKind).toBe('local_loopback');
    expect(p.backend).toBe('codex');
    expect(JSON.stringify(p)).not.toMatch(/https?:|localhost|127\.0/);
  });

  test('no observation state means no payload', () => {
    expect(buildModelObservationPayload({} as any)).toBeUndefined();
  });
});
