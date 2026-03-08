import { describe, test, expect } from 'bun:test';

/**
 * Tests for sidebar task search filtering.
 * Validates that search matches against title, description, and result summary.
 */

interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  project?: string | null;
  updatedAt: Date;
  resultSummary?: string | null;
}

interface Workspace {
  id: string;
  name: string;
  tasks: Task[];
}

// Extracted from WorkspaceSidebar.tsx — the core filter logic
function filterWorkspaces(
  workspaces: Workspace[],
  searchQuery: string,
  projectFilter: string | null,
): Workspace[] {
  const searchLower = searchQuery.toLowerCase();
  return workspaces.map(ws => ({
    ...ws,
    tasks: ws.tasks.filter(t => {
      if (searchQuery) {
        const matchesTitle = t.title.toLowerCase().includes(searchLower);
        const matchesDescription = t.description?.toLowerCase().includes(searchLower) ?? false;
        const matchesResultSummary = t.resultSummary?.toLowerCase().includes(searchLower) ?? false;
        if (!matchesTitle && !matchesDescription && !matchesResultSummary) return false;
      }
      if (projectFilter && t.project !== projectFilter) return false;
      return true;
    }),
  })).filter(ws => ws.tasks.length > 0 || (!searchQuery && !projectFilter));
}

const baseTime = new Date('2025-01-01T00:00:00Z');

function makeWorkspaces(tasks: Task[]): Workspace[] {
  return [{ id: 'ws-1', name: 'Test', tasks }];
}

describe('sidebar task search', () => {
  const tasks: Task[] = [
    {
      id: 'task-1',
      title: 'Fix login bug',
      description: 'Users cannot authenticate with OAuth provider',
      status: 'pending',
      updatedAt: baseTime,
      resultSummary: null,
    },
    {
      id: 'task-2',
      title: 'Add dark mode',
      description: 'Implement theme switching for the dashboard',
      status: 'completed',
      updatedAt: baseTime,
      resultSummary: 'Added dark mode toggle with CSS variables and localStorage persistence',
    },
    {
      id: 'task-3',
      title: 'Refactor API routes',
      description: null,
      status: 'running',
      updatedAt: baseTime,
      resultSummary: null,
    },
    {
      id: 'task-4',
      title: 'Update dependencies',
      description: 'Bump Next.js and React to latest versions',
      status: 'completed',
      updatedAt: baseTime,
      resultSummary: 'PR merged: upgraded Next.js from 15 to 16, fixed breaking changes in middleware',
    },
  ];

  test('matches by title (existing behavior)', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'login', null);
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-1');
  });

  test('matches by description', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'OAuth', null);
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-1');
  });

  test('matches by result summary (PR description)', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'CSS variables', null);
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-2');
  });

  test('matches by result summary containing PR info', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'middleware', null);
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-4');
  });

  test('search is case-insensitive', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'OAUTH', null);
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-1');
  });

  test('matches across multiple fields return all matching tasks', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'dark mode', null);
    // Matches task-2 by title AND description
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-2');
  });

  test('no match returns empty workspace list', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'nonexistent term xyz', null);
    expect(result).toHaveLength(0);
  });

  test('empty search returns all tasks', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), '', null);
    expect(result[0].tasks).toHaveLength(4);
  });

  test('handles tasks with null description and null resultSummary', () => {
    const result = filterWorkspaces(makeWorkspaces(tasks), 'API routes', null);
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('task-3');
  });

  test('combines search with project filter', () => {
    const tasksWithProjects: Task[] = [
      { id: 't1', title: 'Fix bug', description: 'Auth issue', status: 'pending', updatedAt: baseTime, project: 'web' },
      { id: 't2', title: 'Fix another bug', description: 'Auth problem', status: 'pending', updatedAt: baseTime, project: 'api' },
    ];
    const result = filterWorkspaces(makeWorkspaces(tasksWithProjects), 'Auth', 'web');
    expect(result[0].tasks).toHaveLength(1);
    expect(result[0].tasks[0].id).toBe('t1');
  });
});
