import { describe, expect, it } from 'bun:test';
import { canvasPresentation, canvasScopeFromPath, isCanvasToggle, showsAskButton } from './canvas-scope';

const M = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';

describe('canvasScopeFromPath', () => {
  it("a mission or task page scopes the canvas to that object (entry.about)", () => {
    expect(canvasScopeFromPath(`/app/missions/${M}`)).toEqual({ about: { kind: 'mission', id: M }, workspaceId: null, steer: null });
    expect(canvasScopeFromPath(`/app/missions/${M}/settings`)).toEqual({ about: { kind: 'mission', id: M }, workspaceId: null, steer: null });
    expect(canvasScopeFromPath(`/app/tasks/${T}`)).toEqual({ about: { kind: 'task', id: T }, workspaceId: null, steer: null });
    expect(canvasScopeFromPath(`/app/tasks/${T}/respond`)).toEqual({ about: { kind: 'task', id: T }, workspaceId: null, steer: null });
  });

  it('a workspace page scopes the workspace', () => {
    expect(canvasScopeFromPath(`/app/workspaces/${W}`)).toEqual({ about: null, workspaceId: W, steer: null });
    expect(canvasScopeFromPath(`/app/settings/workspace/${W}`)).toEqual({ about: null, workspaceId: W, steer: null });
  });

  it('anything else, or a non-uuid segment, scopes nothing', () => {
    expect(canvasScopeFromPath('/app/home')).toEqual({ about: null, workspaceId: null, steer: null });
    expect(canvasScopeFromPath('/app/missions/new')).toEqual({ about: null, workspaceId: null, steer: null });
    expect(canvasScopeFromPath('/app/tasks/new')).toEqual({ about: null, workspaceId: null, steer: null });
    expect(canvasScopeFromPath(null)).toEqual({ about: null, workspaceId: null, steer: null });
  });
});

describe('showsAskButton', () => {
  it('floats on every app page except chat itself, and only with chat available', () => {
    expect(showsAskButton('/app/home', true)).toBe(true);
    expect(showsAskButton(`/app/missions/${M}`, true)).toBe(true);
    expect(showsAskButton('/app/chat', true)).toBe(false);
    expect(showsAskButton(`/app/chat/${M}`, true)).toBe(false);
    expect(showsAskButton('/app/home', false)).toBe(false);
  });
});

describe('canvasPresentation', () => {
  it('phone takes over the screen; desktop peeks as a right-anchored panel', () => {
    expect(canvasPresentation(390)).toBe('takeover');
    expect(canvasPresentation(767)).toBe('takeover');
    expect(canvasPresentation(768)).toBe('peek');
    expect(canvasPresentation(1440)).toBe('peek');
  });
});

describe('isCanvasToggle', () => {
  const ev = (over: Record<string, unknown>) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  it('⌘K or Ctrl+K, even from a text field', () => {
    expect(isCanvasToggle(ev({ metaKey: true }))).toBe(true);
    expect(isCanvasToggle(ev({ ctrlKey: true }))).toBe(true);
    expect(isCanvasToggle(ev({ key: 'K', metaKey: true }))).toBe(true);
  });
  it('not a bare k, not with shift or alt, not a repeat', () => {
    expect(isCanvasToggle(ev({}))).toBe(false);
    expect(isCanvasToggle(ev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isCanvasToggle(ev({ metaKey: true, altKey: true }))).toBe(false);
    expect(isCanvasToggle(ev({ metaKey: true, repeat: true }))).toBe(false);
  });
});
