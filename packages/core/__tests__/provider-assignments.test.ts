import { describe, expect, it } from 'bun:test';
import { assignedPreference, assignmentError, parseProviderAssignments } from '../providers/assignments';
import { PROVIDER_IDS, providerDescriptor } from '../providers';

describe('parseProviderAssignments', () => {
  it('keeps possible pairs and drops unknown surfaces, providers and impossible pairs', () => {
    expect(parseProviderAssignments(null)).toEqual({});
    expect(parseProviderAssignments([])).toEqual({});
    expect(parseProviderAssignments({ chat: 'openrouter', bogus: 'openrouter', 'agent-claude': 'nope' }))
      .toEqual({ chat: 'openrouter' });
    // A Claude subscription can never run cloud coding: dropped, not stored.
    expect(providerDescriptor('claude-subscription').surfaces['cloud-egress'].ok).toBe(false);
    expect(parseProviderAssignments({ 'cloud-egress': 'claude-subscription' })).toEqual({});
  });
});

describe('assignmentError', () => {
  it('refuses impossible pairs with the registry reason and accepts null to clear', () => {
    expect(assignmentError('chat', 'openrouter')).toBeNull();
    expect(assignmentError('chat', null)).toBeNull();
    expect(assignmentError('nope', 'openrouter')).toContain('surface must be');
    expect(assignmentError('chat', 'nope')).toContain('provider must be');
    const support = providerDescriptor('claude-subscription').surfaces['cloud-egress'];
    expect(assignmentError('cloud-egress', 'claude-subscription')).toBe(support.ok ? null : support.reason);
  });
});

describe('assignedPreference', () => {
  it('puts the assigned provider first and keeps every other provider after it', () => {
    expect(assignedPreference({}, 'chat')).toBeUndefined();
    const order = assignedPreference({ chat: 'openrouter' }, 'chat')!;
    expect(order[0]).toBe('openrouter');
    expect([...order].sort()).toEqual([...PROVIDER_IDS].sort());
    expect(assignedPreference({ chat: 'openrouter' }, 'agent-claude')).toBeUndefined();
  });
});
