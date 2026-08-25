import { describe, it, expect } from 'bun:test';
import {
  BACKEND_REGISTRY,
  DISPATCHABLE_BACKENDS,
  backendLabel,
  failoverCandidates,
  isBackendEnabled,
  isBackendMasked,
  isDispatchableBackend,
  maskBackend,
  pickFailoverBackend,
} from '../backend-policy';

const NOW = new Date('2026-08-25T10:00:00Z');
const LATER = new Date('2026-08-25T15:20:00Z');

describe('backend registry', () => {
  it('only exposes backends the runner can actually execute', () => {
    expect(DISPATCHABLE_BACKENDS).toEqual(['claude', 'codex']);
    expect(BACKEND_REGISTRY.openrouter.dispatchable).toBe(false);
    expect(isDispatchableBackend('openrouter')).toBe(false);
    expect(isDispatchableBackend('codex')).toBe(true);
  });

  it('labels backends from one place, defaulting a missing value to Claude', () => {
    expect(backendLabel('codex')).toBe('Codex');
    expect(backendLabel(null)).toBe('Claude');
    expect(backendLabel('openrouter')).toBe('OpenRouter');
  });

  it('reports enablement against the mask, and never for a non-dispatchable provider', () => {
    expect(isBackendEnabled('claude', ['codex'])).toBe(false);
    expect(isBackendEnabled('claude', ['claude', 'codex'])).toBe(true);
    expect(isBackendEnabled('openrouter', null)).toBe(false);
  });
});

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

describe('failoverCandidates', () => {
  it('offers the other dispatchable backends in registry order', () => {
    expect(failoverCandidates('claude', null)).toEqual(['codex']);
    expect(failoverCandidates('codex', null)).toEqual(['claude']);
  });

  it('never offers a backend the team disabled', () => {
    expect(failoverCandidates('codex', ['codex'])).toEqual([]);
  });
});

describe('pickFailoverBackend', () => {
  it('moves a Codex-walled task to Claude', () => {
    const d = pickFailoverBackend({
      from: 'codex',
      availability: [{ backend: 'claude', configured: true }],
      now: NOW,
    });
    expect(d.backend).toBe('claude');
  });

  it('moves a Claude-walled task to Codex', () => {
    const d = pickFailoverBackend({
      from: 'claude',
      availability: [{ backend: 'codex', configured: true }],
      now: NOW,
    });
    expect(d.backend).toBe('codex');
  });

  it('refuses a target that is itself paused, and says so', () => {
    const d = pickFailoverBackend({
      from: 'codex',
      availability: [{ backend: 'claude', configured: true, pausedUntil: LATER }],
      now: NOW,
    });
    expect(d.backend).toBeNull();
    expect(d.blocked).toEqual([{ backend: 'claude', reason: 'paused', pausedUntil: LATER }]);
  });

  it('accepts a target whose pause has already elapsed', () => {
    const d = pickFailoverBackend({
      from: 'codex',
      availability: [{ backend: 'claude', configured: true, pausedUntil: new Date('2026-08-25T09:00:00Z') }],
      now: NOW,
    });
    expect(d.backend).toBe('claude');
  });

  it('skips an unconfigured or busy target', () => {
    expect(pickFailoverBackend({
      from: 'claude',
      availability: [{ backend: 'codex', configured: false }],
      now: NOW,
    })).toEqual({ backend: null, blocked: [{ backend: 'codex', reason: 'not_configured' }] });

    expect(pickFailoverBackend({
      from: 'claude',
      availability: [{ backend: 'codex', configured: true, busy: true }],
      now: NOW,
    }).blocked).toEqual([{ backend: 'codex', reason: 'busy' }]);
  });

  it('treats an unobserved candidate as unusable rather than dispatching blind', () => {
    expect(pickFailoverBackend({ from: 'claude', availability: [], now: NOW }).backend).toBeNull();
  });

  it('reports the team mask as the blocker when the only alternative is disabled', () => {
    const d = pickFailoverBackend({
      from: 'codex',
      enabledBackends: ['codex'],
      availability: [{ backend: 'claude', configured: true }],
      now: NOW,
    });
    expect(d).toEqual({ backend: null, blocked: [{ backend: 'claude', reason: 'masked' }] });
  });
});
