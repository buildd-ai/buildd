import { describe, expect, it } from 'bun:test';
import { resolveCodingPolicy } from '@buildd/core/coding-policy';
import { codingPolicyAudit, decideCodingPolicy } from './coding-policy-gate';

const base = { cloud: false };

describe('decideCodingPolicy', () => {
  it('unrestricted policy: allow, no source decision (credential delivery untouched)', () => {
    expect(decideCodingPolicy({ ...base, policy: resolveCodingPolicy({}), backend: 'codex', claudeRoute: null }))
      .toEqual({ kind: 'allow', source: null });
  });

  it('Codex explicitly denied', () => {
    const v = decideCodingPolicy({ ...base, policy: resolveCodingPolicy({ team: { allowedBackends: ['claude'] } }), backend: 'codex', claudeRoute: null });
    expect(v.kind).toBe('refuse');
    if (v.kind === 'refuse') expect(v.denied.code).toBe('provider_not_allowed');
  });

  it('backend-only restriction leaves a deliberate API route alone', () => {
    const v = decideCodingPolicy({ ...base, policy: resolveCodingPolicy({ team: { allowedBackends: ['claude'] } }), backend: 'claude', claudeRoute: 'anthropic_api_key' });
    expect(v).toEqual({ kind: 'allow', source: null });
  });

  it('Claude-only with an OpenRouter/endpoint route under a no-metered policy runs natively, not on the endpoint', () => {
    const policy = resolveCodingPolicy({ team: { allowedBackends: ['claude'], allowedSources: ['runner_native'] } });
    expect(decideCodingPolicy({ ...base, policy, backend: 'claude', claudeRoute: 'agent_endpoint' }))
      .toEqual({ kind: 'allow', source: 'runner_native' });
  });

  it('local-only runner with a stored team key: key not used when metered is not authorized', () => {
    const policy = resolveCodingPolicy({ team: { allowedSources: ['runner_native'] } });
    expect(decideCodingPolicy({ ...base, policy, backend: 'claude', claudeRoute: 'anthropic_api_key' }))
      .toEqual({ kind: 'allow', source: 'runner_native' });
  });

  it('cloud with no paid route authorized is deferred, not metered', () => {
    const policy = resolveCodingPolicy({ team: { allowedSources: ['runner_native'] } });
    const v = decideCodingPolicy({ policy, backend: 'claude', claudeRoute: 'cloud_egress', cloud: true });
    expect(v.kind).toBe('refuse');
    if (v.kind === 'refuse') expect(v.denied.code).toBe('payment_source_not_allowed');
  });

  it('user restriction narrows a team that allows metered; unknown requester keeps the team rule only', () => {
    const team = { allowedSources: ['runner_native', 'metered'] as const };
    const known = resolveCodingPolicy({ team: { ...team, allowedSources: [...team.allowedSources] }, member: { allowedSources: ['runner_native'] }, requesterKnown: true });
    expect(decideCodingPolicy({ ...base, policy: known, backend: 'claude', claudeRoute: 'anthropic_api_key' }))
      .toEqual({ kind: 'allow', source: 'runner_native' });
    const unknown = resolveCodingPolicy({ team: { allowedBackends: ['claude', 'codex'] }, member: { allowedSources: ['runner_native'] }, requesterKnown: false });
    expect(decideCodingPolicy({ ...base, policy: unknown, backend: 'claude', claudeRoute: 'anthropic_api_key' }))
      .toEqual({ kind: 'allow', source: null });
  });

  it('the audit line carries provider, source and reason, no credential fields', () => {
    const line = codingPolicyAudit('t1', 'claude', { kind: 'allow', source: 'runner_native' });
    expect(JSON.parse(line)).toEqual({ event: 'coding_policy', taskId: 't1', backend: 'claude', decision: 'allow', source: 'runner_native' });
  });
});
