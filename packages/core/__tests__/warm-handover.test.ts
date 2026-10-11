import { describe, expect, it } from 'bun:test';
import { resolveWarmHandover, isWarmHandover } from '../../shared/src/warm-handover';
describe('warm handover policy', () => {
  it('defaults to off and rejects unknown modes', () => {
    expect(resolveWarmHandover(undefined, undefined)).toBe('off');
    for (const v of [null, true, 'anything', {}]) expect(isWarmHandover(v)).toBe(false);
  });
  it('resolves every team mode and workspace override, including explicit off', () => {
    for (const team of ['off', 'repo', 'deps'] as const) {
      expect(resolveWarmHandover(team, undefined)).toBe(team);
      expect(resolveWarmHandover(team, null)).toBe(team);
      for (const workspace of ['off', 'repo', 'deps'] as const) expect(resolveWarmHandover(team, workspace)).toBe(workspace);
    }
  });
  it('fails closed on invalid workspace policy', () => {
    expect(resolveWarmHandover('deps', 'invalid')).toBe('off');
  });
});
