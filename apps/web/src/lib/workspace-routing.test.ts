import { describe, it, expect } from 'bun:test';
import {
  resolveTaskWorkspace, withWorkspaceRouting, withoutWorkspaceRouting, WORKSPACE_ROUTING_SOURCES,
} from './workspace-routing';

const ids = { a: 'ws-a', b: 'ws-b', c: 'ws-c', d: 'ws-d', e: 'ws-e', f: 'ws-f' };

describe('resolveTaskWorkspace', () => {
  it('prefers explicit over everything', () => {
    const r = resolveTaskWorkspace({
      explicit: { workspaceId: ids.a, ref: 'alpha' }, subject: { workspaceId: ids.b },
      sourceObject: { workspaceId: ids.c, kind: 'task' }, schedule: { workspaceId: ids.d },
      mission: { workspaceId: ids.e }, callerDefault: { workspaceId: ids.f },
    });
    expect(r).toEqual({ ok: true, routing: { workspaceId: ids.a, source: 'explicit', reason: 'the caller named alpha' } });
  });

  it('follows the order subject, source, schedule, mission, caller_default', () => {
    const base = {
      subject: { workspaceId: ids.b }, sourceObject: { workspaceId: ids.c, kind: 'task' },
      schedule: { workspaceId: ids.d }, mission: { workspaceId: ids.e }, callerDefault: { workspaceId: ids.f },
    };
    const sources: string[] = [];
    let input: Parameters<typeof resolveTaskWorkspace>[0] = base;
    for (const drop of ['subject', 'sourceObject', 'schedule', 'mission', 'callerDefault'] as const) {
      const r = resolveTaskWorkspace(input);
      if (r.ok) sources.push(r.routing.source);
      input = { ...input, [drop]: null };
    }
    expect(sources).toEqual(['subject', 'source', 'schedule', 'mission', 'caller_default']);
  });

  it('a declared subject never falls back to the caller default', () => {
    const r = resolveTaskWorkspace({ subject: { workspaceId: ids.b }, callerDefault: { workspaceId: ids.a } });
    expect(r.ok && r.routing.workspaceId).toBe(ids.b);
  });

  it('skips a schedule without a workspace', () => {
    const r = resolveTaskWorkspace({ schedule: { workspaceId: null }, mission: { workspaceId: ids.e } });
    expect(r.ok && r.routing.source).toBe('mission');
  });

  it('fails when nothing applies', () => {
    expect(resolveTaskWorkspace({})).toEqual({ ok: false, error: 'no_workspace' });
  });

  it('every source it can return is a documented one', () => {
    expect(WORKSPACE_ROUTING_SOURCES).toEqual(['explicit', 'subject', 'source', 'schedule', 'mission', 'caller_default']);
  });
});

describe('context stamping', () => {
  it('stamps over a caller-supplied copy', () => {
    const routing = { workspaceId: ids.a, source: 'explicit' as const, reason: 'x' };
    expect(withWorkspaceRouting({ workspaceRouting: 'forged', k: 1 }, routing)).toEqual({ workspaceRouting: routing, k: 1 });
  });
  it('drops a caller copy', () => {
    expect(withoutWorkspaceRouting({ workspaceRouting: 1, k: 2 })).toEqual({ k: 2 });
  });
});
