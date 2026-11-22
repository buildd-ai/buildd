import { describe, expect, it } from 'bun:test';
import { acpLineFor } from './t3-runner-line';

describe('acpLineFor: one line per runner from the runner\'s own report', () => {
  it('says ready when the runner reports the ACP bridge ready', () => {
    expect(acpLineFor({ acp: { ready: true } })).toEqual({ state: 'ready', label: 'Ready' });
  });
  it('says not ready when the runner reports it is not', () => {
    expect(acpLineFor({ acp: { ready: false } }).state).toBe('not-ready');
  });
  it('is unknown when the runner never reported (older runner)', () => {
    for (const env of [null, undefined, {}, { acp: null }, { acp: {} }, { acp: { ready: 'yes' } }, 'x']) {
      expect(acpLineFor(env)).toEqual({ state: 'unknown', label: 'Unknown, update the runner' });
    }
  });
});
