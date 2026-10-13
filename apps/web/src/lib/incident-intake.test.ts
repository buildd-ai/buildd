/**
 * Intake core (docs/specs/bug-intake-and-quality.md §3.1): one writer for
 * incident_reports, idempotent on (workspace, key), never throws, and a
 * reconciliation failure leaves the report with decision = null (AC-26).
 */
import { describe, expect, test } from 'bun:test';
import type { IncidentReport } from '@buildd/shared';
import {
  intakeReport,
  type IncidentReportPort,
  type NewIncidentReport,
  type ReconcileReport,
} from './incident-intake';

function fakePort(): IncidentReportPort & { rows: IncidentReport[]; inserts: number } {
  const rows: IncidentReport[] = [];
  const port = {
    rows,
    inserts: 0,
    async insertIfAbsent(row: NewIncidentReport) {
      port.inserts++;
      if (rows.some((r) => r.workspaceId === row.workspaceId && r.idempotencyKey === row.idempotencyKey)) return null;
      const full: IncidentReport = {
        ...row,
        id: `r${rows.length + 1}`,
        incidentId: null,
        decision: null,
        decidedBy: null,
        reasonCode: null,
        confidence: null,
        decisionRecordId: null,
        movedFromIncidentId: null,
        movedAt: null,
        createdAt: new Date(0).toISOString(),
      };
      rows.push(full);
      return full;
    },
    async findByKey(workspaceId: string, key: string) {
      return rows.find((r) => r.workspaceId === workspaceId && r.idempotencyKey === key) ?? null;
    },
    async applyDecision(id: string, d: Parameters<IncidentReportPort['applyDecision']>[1]) {
      const r = rows.find((x) => x.id === id)!;
      Object.assign(r, d);
      return r;
    },
  };
  return port;
}

const base = {
  workspaceId: 'ws-1',
  source: 'agent_friction' as const,
  idempotencyKey: 'agent_friction:abc',
  title: 'Claim loops on stale path',
  excerpt: 'Error: ENOENT /tmp/x at 2026-10-13T01:02:03Z',
};

describe('intakeReport', () => {
  test('writes one row with fingerprint, redacted excerpt and bounded text', async () => {
    const port = fakePort();
    const out = await intakeReport(
      { ...base, title: 'x'.repeat(300), excerpt: `token sk-${'a'.repeat(30)} ${'y'.repeat(3000)}` },
      { port },
    );
    expect(out.created).toBe(true);
    const r = out.report!;
    expect(r.title.length).toBe(120);
    expect(r.excerpt!.length).toBeLessThanOrEqual(2000);
    expect(r.excerpt).not.toContain('sk-aaaa');
    expect(r.fingerprint).toMatch(/^report:/);
    expect(port.rows).toHaveLength(1);
  });

  test('AC-3: a repeat call with the same key returns the existing report and creates no second row', async () => {
    const port = fakePort();
    const first = await intakeReport(base, { port });
    const second = await intakeReport({ ...base, title: 'different title' }, { port });
    expect(second.created).toBe(false);
    expect(second.report!.id).toBe(first.report!.id);
    expect(port.rows).toHaveLength(1);
  });

  test('the same key in another workspace is a different report', async () => {
    const port = fakePort();
    await intakeReport(base, { port });
    const other = await intakeReport({ ...base, workspaceId: 'ws-2' }, { port });
    expect(other.created).toBe(true);
    expect(port.rows).toHaveLength(2);
  });

  test('a repeat does not reconcile again', async () => {
    const port = fakePort();
    let calls = 0;
    const reconcile: ReconcileReport = async () => { calls++; return null; };
    await intakeReport(base, { port, reconcile });
    await intakeReport(base, { port, reconcile });
    expect(calls).toBe(1);
  });

  test('applies a decision the reconcile seam returns', async () => {
    const port = fakePort();
    const out = await intakeReport(base, {
      port,
      reconcile: async () => ({ decision: 'noise', decidedBy: 'rule', reasonCode: 'test_reason' }),
    });
    expect(out.report!.decision).toBe('noise');
    expect(out.report!.decidedBy).toBe('rule');
  });

  test('AC-26: reconcile throws → call succeeds, report exists with decision null, error logged', async () => {
    const port = fakePort();
    const errors: unknown[] = [];
    const out = await intakeReport(base, {
      port,
      reconcile: async () => { throw new Error('boom'); },
      onError: (err) => errors.push(err),
    });
    expect(out.created).toBe(true);
    expect(out.report!.decision).toBeNull();
    expect(port.rows).toHaveLength(1);
    expect(port.rows[0].decision).toBeNull();
    expect((errors[0] as Error).message).toBe('boom');
  });

  test('the default seam decides nothing', async () => {
    const port = fakePort();
    const out = await intakeReport(base, { port });
    expect(out.report!.decision).toBeNull();
  });

  test('I-8: a failing store returns no report instead of throwing', async () => {
    const errors: unknown[] = [];
    const port = fakePort();
    port.insertIfAbsent = async () => { throw new Error('db down'); };
    const out = await intakeReport(base, { port, onError: (e) => errors.push(e) });
    expect(out).toEqual({ report: null, created: false });
    expect(errors).toHaveLength(1);
  });

  test('derives the subject anchor from refs', async () => {
    const port = fakePort();
    const out = await intakeReport({ ...base, refs: { prNumber: 42, headSha: 'a'.repeat(40) } }, { port });
    expect(out.report!.subjectAnchor?.kind).toBe('pull_request');
    expect(out.report!.subjectAnchor?.prNumber).toBe(42);
  });

  test('caps refs.paths at 20', async () => {
    const port = fakePort();
    const paths = Array.from({ length: 30 }, (_, i) => `a/${i}.ts`);
    const out = await intakeReport({ ...base, refs: { paths } }, { port });
    expect(out.report!.refs.paths).toHaveLength(20);
  });
});
