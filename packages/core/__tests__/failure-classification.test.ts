import { describe, expect, it } from 'bun:test';
import { classifyFailure, isInfrastructureClass } from '../failure-classification';

describe('classifyFailure (backend-failover-policy §1, failure-incident-recovery §18.2)', () => {
  it('a 401 at session start is auth, not a task failure', () => {
    const c = classifyFailure('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid"}}', null);
    expect(c).toEqual({ class: 'auth', family: 'auth' });
  });

  it('reads the trace pattern when the error is empty', () => {
    expect(classifyFailure(null, 'Not logged in · Please run /login').class).toBe('auth');
  });

  it('a provider wall is budget', () => {
    expect(classifyFailure("You've hit your session limit · resets 3am (UTC)", null)).toEqual({ class: 'budget', family: 'budget' });
  });

  it('a released interactive slot is infra, interactive_released', () => {
    expect(classifyFailure('Slot released — local session detached', null)).toEqual({ class: 'infra', family: 'infra.interactive_released' });
  });

  it('two hours of MCP silence and a stale runner are infra, session_lost', () => {
    expect(classifyFailure('Interactive worker released: no MCP activity from its session for 2 hours (claim_task worker, not run by a runner)', null))
      .toEqual({ class: 'infra', family: 'infra.session_lost' });
    expect(classifyFailure('Stale worker expired (no update for 15+ minutes)', null).family).toBe('infra.session_lost');
  });

  it('a recorded infra exit cause is infra even with unrelated text', () => {
    expect(classifyFailure('something odd', null, { exitCause: 'infra_failure' })).toEqual({ class: 'infra', family: 'infra.runner' });
    expect(classifyFailure('x', null, { exitCause: 'reassigned' }).family).toBe('infra.interactive_released');
    expect(classifyFailure('x', null, { exitCause: 'auth_failure' }).class).toBe('auth');
  });

  it('a genuine failure, or anything unrecognised, stays task', () => {
    expect(classifyFailure('npm install failed: Cannot find module react', null)).toEqual({ class: 'task', family: 'task' });
    expect(classifyFailure(null, null)).toEqual({ class: 'task', family: 'task' });
    expect(classifyFailure('tests failed', null, { exitCause: 'code_failure' }).class).toBe('task');
  });

  it('auth and infra are infrastructure; task and budget are not', () => {
    expect(isInfrastructureClass('auth')).toBe(true);
    expect(isInfrastructureClass('infra')).toBe(true);
    expect(isInfrastructureClass('task')).toBe(false);
    expect(isInfrastructureClass('budget')).toBe(false);
  });
});
