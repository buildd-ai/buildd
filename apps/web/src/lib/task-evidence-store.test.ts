import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { formatBashTraceExcerpt } from '@buildd/core/bash-failure-trace';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let taskRow: Row | null = null;
let workerRow: Row | null = null;
let traceRows: Row[] = [];
let updates: Array<{ set: Row }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: async () => taskRow ?? undefined },
      workers: { findFirst: async () => workerRow ?? undefined },
      workspaces: { findFirst: async () => ({ repo: 'o/r' }) },
    },
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => traceRows }) }) }) }),
    update: () => ({
      set: (set: Row) => {
        const entry = { set };
        updates.push(entry);
        return { where: async () => undefined };
      },
    }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', result: 'result' },
  workers: { id: 'id' },
  workspaces: { id: 'id' },
  workerErrorTraces: { pattern: 'pattern', excerpt: 'excerpt', ts: 'ts', workerId: 'workerId' },
}));
mock.module('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  asc: (c: unknown) => ({ asc: c }),
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  inArray: (c: unknown, v: unknown) => ({ inArray: [c, v] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
}));
mock.module('@/lib/github', () => ({ githubApi: async () => ({}), githubApiText: async () => '' }));
mock.module('@/lib/repo-scope', () => ({ resolvePrRepo: ({ workspaceRepo }: { workspaceRepo: string }) => workspaceRepo }));
mock.module('@/lib/workspace-installation', () => ({
  WORKSPACE_INSTALLATION_WITH: {},
  pickWorkspaceRepoIdentity: () => ({ fullName: 'o/r', installationId: 1 }),
  installationIdForRepo: async () => 1,
}));

const { persistTaskEvidence } = await import('./task-evidence-store');

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';

/** The patch the store merged into `result`, parsed back out of the SQL parameter. */
function writtenPatch(): Row | null {
  if (updates.length === 0) return null;
  const values = (updates[0].set.result as { values: unknown[] }).values;
  return JSON.parse(values.filter(v => typeof v === 'string').pop() as string);
}

beforeEach(() => {
  updates = [];
  traceRows = [];
  workerRow = { prUrl: null, prNumber: null, error: null };
  taskRow = { id: 'task-1', status: 'failed', result: {}, context: {}, workspaceId: 'ws-1' };
});

describe('persistTaskEvidence', () => {
  it('seeds keyLines from the CI digest for a failing CI-fix task, redacted', async () => {
    taskRow = {
      ...taskRow!,
      context: {
        failureContext: {
          errorType: 'ci_failure',
          summary: `CI failed on PR #12\nCheck: unit\n(fail) billing > rounds up\nerror: token ${SECRET} rejected`,
        },
      },
    };
    const out = await persistTaskEvidence('task-1', 'worker-1');
    expect(out?.evidence?.keyLinesSource).toBe('ci_digest');
    expect(out?.evidence?.keyLines).toContain('(fail) billing > rounds up');
    const patch = writtenPatch();
    expect(patch?.evidence.errorClass).toBe('test_failure');
    expect(JSON.stringify(patch)).not.toContain(SECRET);
  });

  it('records a bash trace and the last failing command', async () => {
    traceRows = [{
      pattern: 'bash_nonzero_exit',
      excerpt: formatBashTraceExcerpt({ command: 'bun run test', exitCode: 1, output: '(fail) a > b' }),
      ts: new Date('2026-01-01T00:00:00Z'),
    }];
    const out = await persistTaskEvidence('task-1', 'worker-1');
    expect(out?.evidence?.lastFailingCommand?.exitCode).toBe(1);
    expect(out?.evidence?.keyLines).toContain('(fail) a > b');
  });

  it('flags success with a red gating check', async () => {
    taskRow = { ...taskRow!, status: 'completed', result: { summary: 'Fixed it', files: 1, added: 2, removed: 0, prNumber: 5 } };
    const out = await persistTaskEvidence('task-1', 'worker-1', {
      fetchChecks: async () => [{ name: 'unit', state: 'failed', url: 'https://x/job/1' }],
    });
    expect(out?.mismatch.map(m => m.kind)).toEqual(['success_with_red_check']);
    expect(writtenPatch()?.mismatch).toHaveLength(1);
    expect(writtenPatch()?.evidence.ciChecks[0].name).toBe('unit');
  });

  it('writes nothing for a clean run', async () => {
    taskRow = { ...taskRow!, status: 'completed', result: { summary: 'Fixed it', files: 2, added: 5, removed: 1, prNumber: 5 } };
    const out = await persistTaskEvidence('task-1', 'worker-1', {
      fetchChecks: async () => [{ name: 'unit', state: 'passed', url: null }],
    });
    expect(out?.evidence).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('keeps no lines from a sensitive workspace', async () => {
    taskRow = { ...taskRow!, context: { failureContext: { errorType: 'ci_failure', summary: 'error: private detail' } } };
    workerRow = { prUrl: null, prNumber: null, error: 'error: private detail' };
    traceRows = [{ pattern: 'bash_nonzero_exit', excerpt: '$ bun test [exit 1]\nprivate detail', ts: new Date() }];
    await persistTaskEvidence('task-1', 'worker-1', { isSensitive: true });
    expect(JSON.stringify(writtenPatch() ?? {})).not.toContain('private detail');
  });

  it('does nothing for a task that has not ended', async () => {
    taskRow = { ...taskRow!, status: 'in_progress' };
    expect(await persistTaskEvidence('task-1', 'worker-1')).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('never throws', async () => {
    taskRow = null;
    expect(await persistTaskEvidence('task-1', 'worker-1')).toBeNull();
  });
});
