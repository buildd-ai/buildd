import { describe, test, expect } from 'bun:test';
import { normalizeTeamState } from './TeamPanel';

describe('normalizeTeamState', () => {
  test('returns null for null input', () => {
    expect(normalizeTeamState(null)).toBe(null);
  });

  test('returns null for undefined input', () => {
    expect(normalizeTeamState(undefined)).toBe(null);
  });

  test('returns null for non-object input', () => {
    expect(normalizeTeamState('string')).toBe(null);
    expect(normalizeTeamState(42)).toBe(null);
  });

  test('defaults members to [] when field is missing', () => {
    const raw = { teamName: 'test', createdAt: 0, messages: [] };
    const result = normalizeTeamState(raw);
    expect(result?.members).toEqual([]);
  });

  test('defaults messages to [] when field is missing', () => {
    const raw = { teamName: 'test', createdAt: 0, members: [] };
    const result = normalizeTeamState(raw);
    expect(result?.messages).toEqual([]);
  });

  test('defaults both members and messages to [] when both are missing', () => {
    const raw = { teamName: 'test', createdAt: 0 };
    const result = normalizeTeamState(raw);
    expect(result?.members).toEqual([]);
    expect(result?.messages).toEqual([]);
  });

  test('defaults members to [] when field is null', () => {
    const raw = { teamName: 'test', createdAt: 0, members: null, messages: [] };
    const result = normalizeTeamState(raw);
    expect(result?.members).toEqual([]);
  });

  test('defaults messages to [] when field is null', () => {
    const raw = { teamName: 'test', createdAt: 0, members: [], messages: null };
    const result = normalizeTeamState(raw);
    expect(result?.messages).toEqual([]);
  });

  test('preserves valid members and messages arrays', () => {
    const member = { name: 'agent-1', status: 'active' as const, spawnedAt: 1000 };
    const message = { from: 'leader', to: 'agent-1', content: 'hello', timestamp: 1000 };
    const raw = { teamName: 'My Team', createdAt: 123, members: [member], messages: [message] };
    const result = normalizeTeamState(raw);
    expect(result?.teamName).toBe('My Team');
    expect(result?.createdAt).toBe(123);
    expect(result?.members).toHaveLength(1);
    expect(result?.messages).toHaveLength(1);
  });

  test('defaults teamName when missing', () => {
    const raw = { createdAt: 0, members: [], messages: [] };
    const result = normalizeTeamState(raw);
    expect(result?.teamName).toBe('');
  });
});
