import { describe, expect, it } from 'bun:test';
import { describeRunnerRoute } from './runner-route';

describe('describeRunnerRoute', () => {
  it('names the credential source the runner reported, per backend, without a secret', () => {
    const r = describeRunnerRoute({ modelAuthSource: 'machine_login', codexAuthSource: 'api_key' });
    expect(r.claude).toBe('local plan login');
    expect(r.codex).toBe('API key');
  });

  it('reads an unreported source as unknown, never as none', () => {
    const r = describeRunnerRoute({ modelAuthSource: null, codexAuthSource: null });
    expect(r.claude).toBe('not reported');
    expect(r.codex).toBe('not reported');
  });

  it('keeps "no login" distinct from "not reported"', () => {
    expect(describeRunnerRoute({ modelAuthSource: 'none', codexAuthSource: 'none' }).claude).toBe('no login');
  });

  it('does not depend on who owns the runner or who the principal is', () => {
    const a = describeRunnerRoute({ modelAuthSource: 'machine_token', codexAuthSource: null });
    expect(a.claude).toBe('local plan token');
    expect(Object.keys(a).sort()).toEqual(['claude', 'codex']);
  });
});
