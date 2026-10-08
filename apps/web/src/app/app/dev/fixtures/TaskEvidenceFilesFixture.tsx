'use client';

/**
 * `?state=task-evidence`: the task page's Evidence files section in each
 * state, on a stub transport (no database, no bucket). Illustrative data only.
 */
import type { ReactNode } from 'react';
import TaskEvidenceFiles from '../../(protected)/tasks/[id]/TaskEvidenceFiles';
import type { EvidenceObjectSummary, TaskEvidenceReadResponse } from '@buildd/shared';
import type { EvidenceTransport } from '../../(protected)/tasks/[id]/task-evidence-files';

const TASK = 'fixture-task';
const EARLIER = 'fixture-task-earlier';

const obj = (n: number, over: Partial<EvidenceObjectSummary>): EvidenceObjectSummary => ({
  id: `fixture-evidence-${n}`, workspaceId: 'ws-fixture', taskId: TASK, rootTaskId: TASK,
  workerId: 'worker-fixture', scoutRunId: null, prNumber: null, kind: 'command_output', bytes: 48 * 1024, uploadState: 'stored',
  indexState: 'indexed', createdAt: '2026-09-30T14:02:00.000Z', expiresAt: null, ...over,
});

const FAILED_TASK = [
  obj(1, { kind: 'test_report', bytes: 12 * 1024, indexState: 'indexed' }),
  obj(2, { kind: 'command_output', bytes: 236 * 1024, indexState: 'queued', createdAt: '2026-09-30T13:58:00.000Z' }),
  obj(3, { kind: 'ci_job_log', bytes: 2.4 * 1024 * 1024, uploadState: 'failed', indexState: 'skipped', createdAt: '2026-09-30T13:51:00.000Z' }),
  obj(4, { kind: 'transcript', bytes: 640 * 1024, uploadState: 'pending', indexState: 'skipped', createdAt: '2026-09-30T13:50:00.000Z' }),
  obj(5, { kind: 'command_output', bytes: 31 * 1024, taskId: EARLIER, createdAt: '2026-09-30T11:20:00.000Z' }),
];

const SENSITIVE = [obj(6, { kind: 'command_output', bytes: 88 * 1024, indexState: 'skipped' })];

const LOG = Array.from({ length: 1200 }, (_, i) => {
  const n = i + 1;
  if (n % 97 === 0) return `FAIL  src/lib/example.test.ts > case ${n} expected 2, received 3`;
  if (n % 31 === 0) return `$ bun run scripts/run-unit-tests.ts src/lib/example.test.ts  [exit 1]`;
  return `ok    src/lib/example.test.ts > case ${n} (${(n % 9) + 1}ms)`;
});

function respond(object: EvidenceObjectSummary, lines: Array<[number, string]>, over: Partial<TaskEvidenceReadResponse> = {}): TaskEvidenceReadResponse {
  return {
    taskId: TASK, workspaceId: 'ws-fixture', object, text: lines.map(([, s]) => s).join('\n'),
    truncated: false, cursor: null, fromLine: lines[0]?.[0] ?? null, toLine: lines[lines.length - 1]?.[0] ?? null,
    lineCount: lines.length, scannedLines: LOG.length, scanLimited: false, ...over,
  };
}

function transport(objects: EvidenceObjectSummary[]): EvidenceTransport {
  return {
    async read(_taskId, req) {
      const object = objects.find(o => o.id === req.evidenceId)!;
      if (req.grep) {
        if (/\.\*.*\.\*/.test(req.grep)) {
          return { ok: false, status: 400, error: 'grep may use at most one unbounded quantifier (*, + or {n,})' };
        }
        let re: RegExp;
        try { re = new RegExp(req.grep, 'i'); } catch { return { ok: false, status: 400, error: 'grep is not a valid regular expression' }; }
        const start = req.cursor ? Number(req.cursor) : 1;
        const hits = LOG.map((s, i) => [i + 1, s] as [number, string]).filter(([n, s]) => n >= start && re.test(s));
        const page = hits.slice(0, 6);
        const next = hits[6];
        return { ok: true, body: respond(object, page.map(([n, s]) => [n, `${n}:${s}`]), next ? { truncated: true, cursor: String(next[0]) } : {}) };
      }
      const tail = req.tail ?? 200;
      const lines = LOG.map((s, i) => [i + 1, s] as [number, string]).slice(-tail);
      return { ok: true, body: respond(object, lines) };
    },
    async download() {
      return { ok: false, status: 409, error: 'Fixture: downloads are not wired here.' };
    },
    open() {},
  };
}

function Panel({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <p className="font-mono text-xs text-text-secondary">{caption}</p>
      {children}
    </section>
  );
}

export default function TaskEvidenceFilesFixture() {
  return (
    <div className="min-h-screen bg-surface-1 px-4 py-6 md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <h1 className="text-lg font-semibold text-text-primary">Task page: Evidence files</h1>
        <Panel caption="Failed task: every upload state, viewer open on a grep with more below">
          <TaskEvidenceFiles
            taskId={TASK}
            objects={FAILED_TASK}
            transport={transport(FAILED_TASK)}
            defaultOpen
            initialView={{ evidenceId: FAILED_TASK[1].id, grep: 'fail' }}
          />
        </Panel>
        <Panel caption="A grep the server refuses: its message inline">
          <TaskEvidenceFiles
            taskId={TASK}
            objects={FAILED_TASK.slice(0, 1)}
            transport={transport(FAILED_TASK)}
            defaultOpen
            initialView={{ evidenceId: FAILED_TASK[0].id, grep: '.*case.*ms' }}
          />
        </Panel>
        <Panel caption="Sensitive workspace: stored, never indexed">
          <TaskEvidenceFiles taskId={TASK} objects={SENSITIVE} transport={transport(SENSITIVE)} sensitive defaultOpen />
        </Panel>
        <Panel caption="No evidence stored">
          <TaskEvidenceFiles taskId={TASK} objects={[]} transport={transport([])} defaultOpen />
        </Panel>
      </div>
    </div>
  );
}
