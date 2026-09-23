import { describe, it, expect } from 'bun:test';
import {
  compareCliVersions,
  checkModelClientCapability,
  MODEL_MIN_CLI_VERSION,
} from '../model-capability-requirements';

describe('compareCliVersions', () => {
  it('reports equal versions as 0', () => {
    expect(compareCliVersions('2.1.251', '2.1.251')).toBe(0);
  });

  it('reports a lower patch as -1', () => {
    expect(compareCliVersions('2.1.238', '2.1.251')).toBe(-1);
  });

  it('reports a higher patch as 1', () => {
    expect(compareCliVersions('2.1.272', '2.1.251')).toBe(1);
  });

  it('compares minor/major components before patch', () => {
    expect(compareCliVersions('2.0.999', '2.1.0')).toBe(-1);
    expect(compareCliVersions('3.0.0', '2.1.251')).toBe(1);
  });

  it('treats missing trailing components as 0', () => {
    expect(compareCliVersions('2.1', '2.1.0')).toBe(0);
  });
});

describe('checkModelClientCapability', () => {
  const requiredVersion = MODEL_MIN_CLI_VERSION['claude-fable-5-1'];

  it('refuses a runner whose CLI predates the model floor', () => {
    const result = checkModelClientCapability('claude-fable-5-1', '2.1.238');
    expect(result).toEqual({ ok: false, requiredVersion });
  });

  it('allows a runner whose CLI meets the model floor exactly', () => {
    expect(checkModelClientCapability('claude-fable-5-1', requiredVersion)).toEqual({ ok: true });
  });

  it('allows a runner whose CLI exceeds the model floor', () => {
    expect(checkModelClientCapability('claude-fable-5-1', '2.1.272')).toEqual({ ok: true });
  });

  it('fails open when the model has no known floor', () => {
    expect(checkModelClientCapability('claude-sonnet-5', '0.0.1')).toEqual({ ok: true });
  });

  it('fails open when the runner reports no CLI version', () => {
    expect(checkModelClientCapability('claude-fable-5-1', undefined)).toEqual({ ok: true });
    expect(checkModelClientCapability('claude-fable-5-1', null)).toEqual({ ok: true });
  });
});

describe('claude-opus-5-5 floor', () => {
  // A catalog-picked premium model with no floor here passes the claim gate and
  // then 400s on every attempt from an older runner CLI.
  it('refuses a runner below the floor the API names for it', () => {
    expect(checkModelClientCapability('claude-opus-5-5', '2.1.272')).toEqual({
      ok: false,
      requiredVersion: '2.1.280',
    });
  });

  it('allows a runner at the floor', () => {
    expect(checkModelClientCapability('claude-opus-5-5', '2.1.280')).toEqual({ ok: true });
  });
});
