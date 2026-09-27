import { describe, it, expect } from 'bun:test';
import { buildWorkspaceParam, scopeChipLabel } from './WorkspaceSwitcher';

describe('scopeChipLabel', () => {
  const ws = [{ id: 'a', name: 'billing-web' }];
  it('all workspaces in scope: the long label for desktop, `all` on a phone', () => {
    expect(scopeChipLabel(ws, null, null)).toEqual({ glyph: '@', name: 'All workspaces', short: 'all' });
  });
  it('a pinned or routed workspace has no separate short form', () => {
    expect(scopeChipLabel(ws, 'a', null)).toEqual({ glyph: '@', name: 'billing-web', short: 'billing-web' });
    expect(scopeChipLabel(ws, null, ws[0])).toEqual({ glyph: '→', name: 'billing-web', short: 'billing-web' });
  });
});

describe('buildWorkspaceParam', () => {
  it('returns empty string (no param) when workspaceId is null — team-wide default', () => {
    expect(buildWorkspaceParam('', null)).toBe('');
  });

  it('sets ?workspace=<id> when a workspace is selected', () => {
    expect(buildWorkspaceParam('', 'ws-abc')).toBe('workspace=ws-abc');
  });

  it('replaces an existing workspace param with the new selection', () => {
    expect(buildWorkspaceParam('workspace=old', 'ws-new')).toBe('workspace=ws-new');
  });

  it('removes the workspace param when selection is cleared — simulates team switch clear', () => {
    expect(buildWorkspaceParam('workspace=ws-abc', null)).toBe('');
  });

  it('preserves unrelated query params when setting a workspace', () => {
    const result = buildWorkspaceParam('foo=bar', 'ws-1');
    expect(result).toContain('workspace=ws-1');
    expect(result).toContain('foo=bar');
  });

  it('preserves unrelated query params when clearing workspace', () => {
    const result = buildWorkspaceParam('workspace=ws-1&foo=bar', null);
    expect(result).not.toContain('workspace');
    expect(result).toContain('foo=bar');
  });
});
