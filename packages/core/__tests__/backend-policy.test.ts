import { describe, it, expect } from 'bun:test';
import {
  BACKEND_REGISTRY,
  DISPATCHABLE_BACKENDS,
  backendLabel,
  BACKEND_PINNED_KEY,
  BACKEND_ROUTING_KEY,
  claimedBackendOf,
  describeBackendRouting,
  failoverCandidates,
  isBackendPinned,
  isBackendEnabled,
  isBackendMasked,
  isDispatchableBackend,
  maskBackend,
  pickFailoverBackend,
  resolveEffectiveBackend,
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

describe('resolveEffectiveBackend', () => {
  it('returns the stored per-task backend when the team mask allows it', () => {
    expect(resolveEffectiveBackend('codex', null)).toBe('codex');
    expect(resolveEffectiveBackend('codex', ['claude', 'codex'])).toBe('codex');
    expect(resolveEffectiveBackend('claude', [])).toBe('claude');
  });

  it('treats a null/unknown stored backend as the schema default', () => {
    // tasks.backend is NOT NULL DEFAULT 'claude', but callers that select it
    // loosely (or a future nullable column) must not resolve to undefined.
    expect(resolveEffectiveBackend(null, null)).toBe('claude');
    expect(resolveEffectiveBackend(undefined, null)).toBe('claude');
    expect(resolveEffectiveBackend('openrouter', null)).toBe('claude');
    expect(resolveEffectiveBackend('nonsense', null)).toBe('claude');
  });

  it('applies the team mask, exactly as the claim route does at dispatch time', () => {
    expect(resolveEffectiveBackend('codex', ['claude'])).toBe('claude');
    expect(resolveEffectiveBackend('claude', ['codex'])).toBe('codex');
  });

  it('agrees with maskBackend for every dispatchable backend and mask', () => {
    const masks: Array<AgentBackendList> = [null, [], ['claude'], ['codex'], ['claude', 'codex']];
    for (const stored of DISPATCHABLE_BACKENDS) {
      for (const mask of masks) {
        expect(resolveEffectiveBackend(stored, mask)).toBe(maskBackend(stored, mask));
      }
    }
  });
});

type AgentBackendList = Parameters<typeof maskBackend>[1];

describe('pinned backend', () => {
  it('reads the creator pin off the task context', () => {
    expect(isBackendPinned({ [BACKEND_PINNED_KEY]: true })).toBe(true);
  });

  it('treats a missing, false or non-boolean marker as not pinned', () => {
    expect(isBackendPinned(null)).toBe(false);
    expect(isBackendPinned(undefined)).toBe(false);
    expect(isBackendPinned({})).toBe(false);
    expect(isBackendPinned({ [BACKEND_PINNED_KEY]: false })).toBe(false);
    expect(isBackendPinned({ [BACKEND_PINNED_KEY]: 'yes' })).toBe(false);
  });
});

describe('describeBackendRouting', () => {
  it('explains a claim-time budget failover in words', () => {
    const d = describeBackendRouting({
      [BACKEND_ROUTING_KEY]: { backend: 'codex', from: 'claude', reason: 'claude_seat_exhausted', at: NOW.toISOString() },
    });
    expect(d).not.toBeNull();
    expect(d!.backend).toBe('codex');
    expect(d!.from).toBe('claude');
    expect(d!.source).toBe('claim');
    expect(d!.summary).toBe('routed to Codex by budget failover (Claude seat exhausted)');
  });

  it('explains the provider toggle and the reverse wall', () => {
    expect(describeBackendRouting({
      [BACKEND_ROUTING_KEY]: { backend: 'codex', from: 'claude', reason: 'claude_disabled' },
    })!.summary).toBe('routed to Codex because Claude is disabled for the team');
    expect(describeBackendRouting({
      [BACKEND_ROUTING_KEY]: { backend: 'claude', from: 'codex', reason: 'codex_rate_limited' },
    })!.summary).toBe('routed to Claude by budget failover (Codex rate-limited)');
  });

  it('falls back to a worker-report failover stamp', () => {
    const d = describeBackendRouting({ failedOverFrom: 'codex', failoverReason: 'budget_exhausted' }, 'claude');
    expect(d).toEqual({
      backend: 'claude', from: 'codex', reason: 'budget_exhausted', source: 'worker_report',
      summary: 'moved to Claude by failover after Codex hit a budget wall',
    });
    expect(describeBackendRouting({ failedOverFrom: 'claude', failoverReason: 'auth_failure' }, 'codex')!.summary)
      .toBe('moved to Codex by failover after Claude rejected its credential');
  });

  it('prefers the newer claim-time stamp over an older worker-report one', () => {
    const d = describeBackendRouting({
      failedOverFrom: 'codex', failoverReason: 'budget_exhausted',
      [BACKEND_ROUTING_KEY]: { backend: 'codex', from: 'claude', reason: 'claude_seat_exhausted' },
    }, 'claude');
    expect(d!.source).toBe('claim');
  });

  it('is null when the backend was never changed, and ignores malformed stamps', () => {
    expect(describeBackendRouting(null)).toBeNull();
    expect(describeBackendRouting({})).toBeNull();
    expect(describeBackendRouting({ [BACKEND_ROUTING_KEY]: 'codex' })).toBeNull();
    expect(describeBackendRouting({ [BACKEND_ROUTING_KEY]: { backend: 'gpt', from: 'claude', reason: 'x' } })).toBeNull();
  });
});

// The single-flight gate asks "is a Codex run live in this workspace?" of each
// active task. A claim-time flip leaves the row's stored backend alone, so the
// stored column alone answers "no" for a Codex run that failover started.
describe('claimedBackendOf', () => {
  it('reads the claim stamp over the stored backend', () => {
    const ctx = { [BACKEND_ROUTING_KEY]: { backend: 'codex', from: 'claude', reason: 'claude_seat_exhausted' } };
    expect(claimedBackendOf('claude', ctx)).toBe('codex');
    expect(claimedBackendOf(null, ctx)).toBe('codex');
  });

  it('falls back to the stored backend when no claim moved the task', () => {
    expect(claimedBackendOf('codex', null)).toBe('codex');
    expect(claimedBackendOf('claude', {})).toBe('claude');
    expect(claimedBackendOf(null, {})).toBe('claude');
  });

  it('ignores a malformed stamp', () => {
    expect(claimedBackendOf('claude', { [BACKEND_ROUTING_KEY]: 'codex' })).toBe('claude');
    expect(claimedBackendOf('claude', { [BACKEND_ROUTING_KEY]: { backend: 'gpt' } })).toBe('claude');
  });
});
