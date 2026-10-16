import { beforeEach, describe, expect, it, mock } from 'bun:test';

const tasksFindMany = mock((_q?: unknown) => Promise.resolve([] as any[]));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findMany: tasksFindMany } } } }));

const { attachVisualAuditRoutes, renderVisualAuditRoutes, VISUAL_AUDIT_ROUTES_CONTEXT_KEY } = await import('./visual-audit-routes');

const page = 'apps/web/src/app/app/(protected)/missions/[id]/page.tsx';
const worker = (taskId: string) => ({ taskId, task: { id: taskId, context: {} } }) as any;

beforeEach(() => {
  tasksFindMany.mockReset();
  tasksFindMany.mockResolvedValue([]);
});

describe('renderVisualAuditRoutes', () => {
  it('lists every route and says it overrides the description', () => {
    const block = renderVisualAuditRoutes(['/app/a', '/app/b'])!;
    expect(block).toContain('## Required routes (computed at claim)');
    expect(block).toContain('- `/app/a`\n- `/app/b`');
    expect(block).toContain('this list wins');
  });

  it('renders nothing with no routes', () => {
    expect(renderVisualAuditRoutes([])).toBeNull();
  });
});

describe('attachVisualAuditRoutes', () => {
  it("states the routes the gate will check, from the audit's current dependencies", async () => {
    tasksFindMany.mockResolvedValue([
      { title: 'fix: page', context: null, pathManifest: [page] },
      { title: 'chore(mission): merge dev into the X integration branch', context: null, pathManifest: ['apps/web/src/app/app/(protected)/layout.tsx'] },
    ]);
    const cw = worker('audit-1');
    await attachVisualAuditRoutes([cw], [{
      id: 'audit-1', roleSlug: 'visual-auditor', dependsOn: ['b1', 'r1'], context: { visualQa: { requiredRoutes: ['/app/tasks'] } },
    }]);
    expect(cw.task.context[VISUAL_AUDIT_ROUTES_CONTEXT_KEY]).toEqual(['/app/missions/:id', '/app/tasks']);
    expect(cw.resolvedContextProviders).toHaveLength(1);
    expect(cw.resolvedContextProviders[0]).toContain('/app/missions/:id');
  });

  it('leaves every other role alone, and a read failure attaches nothing', async () => {
    const other = worker('t-1');
    await attachVisualAuditRoutes([other], [{ id: 't-1', roleSlug: 'builder', dependsOn: ['b1'] }]);
    expect(tasksFindMany).not.toHaveBeenCalled();
    expect(other.resolvedContextProviders).toBeUndefined();

    tasksFindMany.mockRejectedValue(new Error('db down'));
    const audit = worker('audit-1');
    await attachVisualAuditRoutes([audit], [{ id: 'audit-1', roleSlug: 'visual-auditor', dependsOn: ['b1'] }]);
    expect(audit.resolvedContextProviders).toBeUndefined();
  });
});
