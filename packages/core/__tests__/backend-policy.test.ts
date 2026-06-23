import { describe, it, expect } from 'bun:test';
import { maskBackend, isBackendMasked } from '../backend-policy';

describe('maskBackend', () => {
  it('no mask when enabled list is null/undefined/empty (all enabled)', () => {
    expect(maskBackend('claude', null)).toBe('claude');
    expect(maskBackend('codex', undefined)).toBe('codex');
    expect(maskBackend('claude', [])).toBe('claude');
  });

  it('leaves the backend unchanged when it is enabled', () => {
    expect(maskBackend('claude', ['claude', 'codex'])).toBe('claude');
    expect(maskBackend('codex', ['claude', 'codex'])).toBe('codex');
    expect(maskBackend('codex', ['codex'])).toBe('codex');
  });

  it('redirects to the first enabled provider when the resolved one is disabled', () => {
    // Cancelled Claude → only Codex enabled → claude jobs run on codex.
    expect(maskBackend('claude', ['codex'])).toBe('codex');
    // Inverse: only Claude enabled → codex jobs run on claude.
    expect(maskBackend('codex', ['claude'])).toBe('claude');
  });

  it('fails open (returns resolved) if nothing is enabled — never blocks all work', () => {
    // Empty already covered as "no mask"; guard against a malformed list too.
    expect(maskBackend('claude', [] as any)).toBe('claude');
  });

  it('is reversible: re-enabling restores the original backend with no stored state', () => {
    const resolved = 'claude' as const;
    expect(maskBackend(resolved, ['codex'])).toBe('codex');     // disabled
    expect(maskBackend(resolved, ['claude', 'codex'])).toBe('claude'); // re-enabled → original
  });
});

describe('isBackendMasked', () => {
  it('reports whether the mask redirects', () => {
    expect(isBackendMasked('claude', ['codex'])).toBe(true);
    expect(isBackendMasked('claude', ['claude', 'codex'])).toBe(false);
    expect(isBackendMasked('codex', null)).toBe(false);
  });
});
