import { describe, it, expect } from 'bun:test';
import { buildDelegateOptions } from './delegate-options';

const wsNames = new Map([
  ['ws-a', 'Alpha'],
  ['ws-b', 'Beta'],
]);

describe('buildDelegateOptions', () => {
  it('emits one option per slug when the same role exists in several workspaces', () => {
    const opts = buildDelegateOptions(
      [
        { slug: 'builder', name: 'Builder', workspaceId: 'ws-a' },
        { slug: 'builder', name: 'Builder', workspaceId: 'ws-b' },
        { slug: 'researcher', name: 'Researcher', workspaceId: 'ws-a' },
      ],
      'organizer',
      wsNames,
    );
    const slugs = opts.map(o => o.slug);
    expect(slugs).toEqual(['builder', 'researcher']);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('excludes the role being edited', () => {
    const opts = buildDelegateOptions(
      [
        { slug: 'builder', name: 'Builder', workspaceId: null },
        { slug: 'organizer', name: 'Organizer', workspaceId: 'ws-a' },
      ],
      'builder',
      wsNames,
    );
    expect(opts.map(o => o.slug)).toEqual(['organizer']);
  });

  it('prefers the team-level row, which carries no workspace qualifier', () => {
    const opts = buildDelegateOptions(
      [
        { slug: 'builder', name: 'Builder (ws copy)', workspaceId: 'ws-a' },
        { slug: 'builder', name: 'Builder', workspaceId: null },
      ],
      'organizer',
      wsNames,
    );
    expect(opts).toEqual([{ slug: 'builder', name: 'Builder', workspaceName: undefined }]);
  });

  it('keeps the workspace name when a slug exists in exactly one workspace', () => {
    const opts = buildDelegateOptions(
      [{ slug: 'qa', name: 'QA', workspaceId: 'ws-b' }],
      'organizer',
      wsNames,
    );
    expect(opts).toEqual([{ slug: 'qa', name: 'QA', workspaceName: 'Beta' }]);
  });

  it('drops the workspace qualifier when one slug spans several workspaces', () => {
    const opts = buildDelegateOptions(
      [
        { slug: 'qa', name: 'QA', workspaceId: 'ws-a' },
        { slug: 'qa', name: 'QA', workspaceId: 'ws-b' },
      ],
      'organizer',
      wsNames,
    );
    expect(opts).toEqual([{ slug: 'qa', name: 'QA', workspaceName: undefined }]);
  });
});
