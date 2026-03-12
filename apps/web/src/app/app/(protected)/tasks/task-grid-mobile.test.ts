import { describe, test, expect } from 'bun:test';

/**
 * Tests for TaskGrid mobile improvements:
 * - Output type indicators (PR/artifact) replace category color coding
 * - Workspace rows sort active-first
 * - Needs-input tasks extracted cross-workspace
 */

interface GridTask {
  id: string;
  title: string;
  status: string;
  category: string | null;
  updatedAt: string;
  workspaceName: string;
  prUrl: string | null;
  prNumber: number | null;
  summary: string | null;
  hasArtifact: boolean;
  filesChanged: number | null;
  waitingPrompt: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
}

// Extracted from TaskGrid.tsx — the core sorting/grouping logic
const STATUS_PRIORITY: Record<string, number> = {
  waiting_input: 0,
  in_progress: 1,
  assigned: 2,
  pending: 3,
  failed: 4,
  completed: 5,
};

function isActive(status: string): boolean {
  return ['in_progress', 'assigned', 'pending', 'waiting_input'].includes(status);
}

interface WorkspaceRow {
  workspaceName: string;
  items: Array<{ type: 'single'; task: GridTask } | { type: 'collapsed'; objectiveId: string; objectiveTitle: string; tasks: GridTask[]; latestTask: GridTask; count: number }>;
  hasActive: boolean;
  latestUpdate: string;
}

function buildWorkspaceRows(tasks: GridTask[]): { needsInput: GridTask[]; workspaceRows: WorkspaceRow[] } {
  const needsInput = tasks.filter(t => t.status === 'waiting_input');
  const nonWaiting = tasks.filter(t => t.status !== 'waiting_input');
  const byWorkspace = new Map<string, GridTask[]>();
  for (const t of nonWaiting) {
    const existing = byWorkspace.get(t.workspaceName) || [];
    existing.push(t);
    byWorkspace.set(t.workspaceName, existing);
  }

  const workspaceRows: WorkspaceRow[] = [];
  for (const [workspaceName, wsTasks] of byWorkspace) {
    const sorted = [...wsTasks].sort((a, b) => {
      const aPri = STATUS_PRIORITY[a.status] ?? 99;
      const bPri = STATUS_PRIORITY[b.status] ?? 99;
      if (aPri !== bPri) return aPri - bPri;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const completedByObjective = new Map<string, GridTask[]>();
    const items: WorkspaceRow['items'] = [];
    const deferredObjectiveIds = new Set<string>();
    for (const t of sorted) {
      if (t.status === 'completed' && t.objectiveId) {
        const group = completedByObjective.get(t.objectiveId) || [];
        group.push(t);
        completedByObjective.set(t.objectiveId, group);
      }
    }
    for (const [objId, group] of completedByObjective) {
      if (group.length >= 3) deferredObjectiveIds.add(objId);
    }
    const addedObjectives = new Set<string>();
    for (const t of sorted) {
      if (t.status === 'completed' && t.objectiveId && deferredObjectiveIds.has(t.objectiveId)) {
        if (!addedObjectives.has(t.objectiveId)) {
          addedObjectives.add(t.objectiveId);
          const group = completedByObjective.get(t.objectiveId)!;
          items.push({ type: 'collapsed', objectiveId: t.objectiveId, objectiveTitle: t.objectiveTitle || t.title, tasks: group, latestTask: group[0], count: group.length });
        }
        continue;
      }
      items.push({ type: 'single', task: t });
    }

    const hasActiveTask = wsTasks.some(t => isActive(t.status));
    const latestUpdate = sorted[0]?.updatedAt || '';
    workspaceRows.push({ workspaceName, items, hasActive: hasActiveTask, latestUpdate });
  }

  workspaceRows.sort((a, b) => {
    if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
    return new Date(b.latestUpdate).getTime() - new Date(a.latestUpdate).getTime();
  });

  return { needsInput, workspaceRows };
}

// Helper to determine output type indicator (logic matching TaskTile)
function getOutputType(task: GridTask): 'pr' | 'artifact' | 'none' {
  if (task.prUrl) return 'pr';
  if (task.hasArtifact) return 'artifact';
  return 'none';
}

const baseTime = '2025-01-01T00:00:00Z';

function makeTask(overrides: Partial<GridTask> & { id: string }): GridTask {
  return {
    title: `Task ${overrides.id}`,
    status: 'completed',
    category: null,
    updatedAt: baseTime,
    workspaceName: 'ws-1',
    prUrl: null,
    prNumber: null,
    summary: null,
    hasArtifact: false,
    filesChanged: null,
    waitingPrompt: null,
    objectiveId: null,
    objectiveTitle: null,
    ...overrides,
  };
}

describe('output type indicators replace category colors', () => {
  test('task with PR shows pr output type', () => {
    const task = makeTask({ id: 't1', prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 });
    expect(getOutputType(task)).toBe('pr');
  });

  test('task with artifact but no PR shows artifact output type', () => {
    const task = makeTask({ id: 't1', hasArtifact: true });
    expect(getOutputType(task)).toBe('artifact');
  });

  test('task with both PR and artifact shows pr (PR takes precedence)', () => {
    const task = makeTask({ id: 't1', prUrl: 'https://github.com/org/repo/pull/1', prNumber: 1, hasArtifact: true });
    expect(getOutputType(task)).toBe('pr');
  });

  test('task with neither PR nor artifact shows none', () => {
    const task = makeTask({ id: 't1' });
    expect(getOutputType(task)).toBe('none');
  });

  test('category is irrelevant to output type', () => {
    const task = makeTask({ id: 't1', category: 'bug', prUrl: 'https://github.com/org/repo/pull/5', prNumber: 5 });
    expect(getOutputType(task)).toBe('pr');
    // Category should NOT affect the visual indicator
  });
});

describe('workspace rows sort active workspaces first', () => {
  test('workspace with active tasks sorts before inactive', () => {
    const tasks = [
      makeTask({ id: 't1', workspaceName: 'inactive-ws', status: 'completed', updatedAt: '2025-01-02T00:00:00Z' }),
      makeTask({ id: 't2', workspaceName: 'active-ws', status: 'in_progress', updatedAt: '2025-01-01T00:00:00Z' }),
    ];
    const { workspaceRows } = buildWorkspaceRows(tasks);
    expect(workspaceRows[0].workspaceName).toBe('active-ws');
    expect(workspaceRows[1].workspaceName).toBe('inactive-ws');
  });

  test('among inactive workspaces, most recently updated sorts first', () => {
    const tasks = [
      makeTask({ id: 't1', workspaceName: 'old-ws', status: 'completed', updatedAt: '2025-01-01T00:00:00Z' }),
      makeTask({ id: 't2', workspaceName: 'new-ws', status: 'completed', updatedAt: '2025-01-03T00:00:00Z' }),
    ];
    const { workspaceRows } = buildWorkspaceRows(tasks);
    expect(workspaceRows[0].workspaceName).toBe('new-ws');
  });
});

describe('needs-input tasks extracted cross-workspace', () => {
  test('waiting_input tasks are in needsInput, not in workspace rows', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'waiting_input', waitingPrompt: 'Need API key', workspaceName: 'ws-1' }),
      makeTask({ id: 't2', status: 'completed', workspaceName: 'ws-1' }),
      makeTask({ id: 't3', status: 'waiting_input', waitingPrompt: 'Choose option', workspaceName: 'ws-2' }),
    ];
    const { needsInput, workspaceRows } = buildWorkspaceRows(tasks);
    expect(needsInput).toHaveLength(2);
    expect(needsInput.map(t => t.id).sort()).toEqual(['t1', 't3']);
    // Workspace rows should not contain waiting_input tasks
    for (const row of workspaceRows) {
      for (const item of row.items) {
        if (item.type === 'single') {
          expect(item.task.status).not.toBe('waiting_input');
        }
      }
    }
  });
});

describe('tasks within workspace sort by status then recency', () => {
  test('active tasks appear before completed', () => {
    const tasks = [
      makeTask({ id: 't-completed', status: 'completed', updatedAt: '2025-01-03T00:00:00Z', workspaceName: 'ws' }),
      makeTask({ id: 't-running', status: 'in_progress', updatedAt: '2025-01-01T00:00:00Z', workspaceName: 'ws' }),
      makeTask({ id: 't-pending', status: 'pending', updatedAt: '2025-01-02T00:00:00Z', workspaceName: 'ws' }),
    ];
    const { workspaceRows } = buildWorkspaceRows(tasks);
    const ids = workspaceRows[0].items
      .filter((i): i is { type: 'single'; task: GridTask } => i.type === 'single')
      .map(i => i.task.id);
    expect(ids[0]).toBe('t-running');
    expect(ids[1]).toBe('t-pending');
    expect(ids[2]).toBe('t-completed');
  });
});
