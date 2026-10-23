import { describe, expect, it } from 'bun:test';
import { blocksList, hiddenDependentsLine, needsList } from './task-page-dependencies';
import type { DependencyHolder } from './task-dependency-reach';

const holder = (id: string, o: Partial<DependencyHolder> = {}): DependencyHolder => ({
  id, hidden: false, title: `Title ${id}`, workspaceId: 'ws-x', workspaceName: null, ...o,
});

describe('task page: what a task needs (spec e28018c2 R-6, AC-8)', () => {
  it('names a visible upstream in another workspace with that workspace and links it', () => {
    const rows = needsList(
      [{ id: 'up-a', title: 'Ship the API', status: 'pending' }],
      new Map([['up-a', holder('up-a', { workspaceName: 'App' })]]),
    );
    expect(rows).toEqual([{ id: 'up-a', hidden: false, title: 'Ship the API', status: 'pending', workspaceName: 'App', href: '/app/tasks/up-a' }]);
  });

  it('a hidden upstream carries no title, status, workspace or link', () => {
    const rows = needsList(
      [{ id: 'up-a', title: 'Private plan', status: 'failed' }],
      new Map([['up-a', holder('up-a', { hidden: true, title: null, workspaceId: null })]]),
    );
    expect(rows).toEqual([{ id: 'up-a', hidden: true, title: "a task in a workspace you can't see", status: null, workspaceName: null, href: null }]);
  });
});

describe('task page: what this task blocks (spec e28018c2 R-9, AC-16)', () => {
  it('AC-16: lists a dependent in another workspace with its workspace named', () => {
    const { visible, hiddenCount } = blocksList(
      [{ id: 'dep-b', title: 'Write the docs', label: null, status: 'pending' }],
      new Map([['dep-b', holder('dep-b', { workspaceName: 'Docs' })]]),
    );
    expect(visible).toEqual([{ id: 'dep-b', title: 'Write the docs', label: null, status: 'pending', workspaceName: 'Docs' }]);
    expect(hiddenCount).toBe(0);
  });

  it('counts the dependents the viewer cannot see and never lists them', () => {
    const { visible, hiddenCount } = blocksList(
      [
        { id: 'dep-b', title: 'Write the docs', label: null, status: 'pending' },
        { id: 'dep-c', title: 'Private', label: null, status: 'pending' },
        { id: 'dep-d', title: 'Private too', label: null, status: 'pending' },
      ],
      new Map([
        ['dep-b', holder('dep-b')],
        ['dep-c', holder('dep-c', { hidden: true, title: null })],
        ['dep-d', holder('dep-d', { hidden: true, title: null })],
      ]),
    );
    expect(visible.map(v => v.id)).toEqual(['dep-b']);
    expect(hiddenCount).toBe(2);
    expect(hiddenDependentsLine(2)).toBe("2 tasks in workspaces you can't see wait on this");
    expect(hiddenDependentsLine(1)).toBe("1 task in a workspace you can't see waits on this");
    expect(hiddenDependentsLine(0)).toBeNull();
  });
});
