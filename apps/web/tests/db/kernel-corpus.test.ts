/**
 * The kernel corpus export (scripts/forensics/export-kernel-corpus.ts) against
 * a local database seeded with synthetic deliveries recorded by the real
 * kernel: it refuses a path inside the repo, honours --since / --limit /
 * --errors-first / --workspace, sanitizes, and what it writes replays through
 * the current kernel decision-for-decision.
 *
 * KERNEL_REPLAY_WRITE_FIXTURE=1 also rewrites the checked-in synthetic corpus
 * (apps/web/src/lib/workflow/testing/fixtures/synthetic-corpus.jsonl) from this
 * export, so the fixture is always something the real kernel recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactIds, readCorpus } from '../../src/lib/workflow/testing/corpus';
import { exportCorpus, assertOutsideRepo } from '../../src/lib/workflow/testing/corpus-export';
import { formatReport, replayCorpus } from '../../src/lib/workflow/testing/replay';
import { db } from '@buildd/core/db';
import { main, neonQuery } from '../../../../scripts/forensics/export-kernel-corpus';
import { assertDbConfigured, seedWorkspace } from './harness';
import { SEED_BRANCH, SEED_PROSE, SEED_REPO, seedKernelCorpus } from './kernel-corpus-seed';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const FIXTURE = join(REPO_ROOT, 'apps/web/src/lib/workflow/testing/fixtures/synthetic-corpus.jsonl');
const exec = (q: Parameters<typeof db.execute>[0]) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

let workspaceId: string;
let seeded: Awaited<ReturnType<typeof seedKernelCorpus>>;
let dir: string;
const query = () => neonQuery(process.env.DATABASE_URL!);

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
  seeded = await seedKernelCorpus(workspaceId);
  dir = mkdtempSync(join(tmpdir(), 'kernel-corpus-'));
}, 120_000);

// The seeded deliveries' outbox rows are pending: leave none behind for a later
// file's global effect drain (workflow-kernel.test.ts drains `limit: 50`).
afterAll(async () => {
  await db.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`);
});

describe('export refuses to write inside the repository', () => {
  test('a path in the work tree throws and writes nothing', async () => {
    const out = join(REPO_ROOT, 'apps/web/kernel-corpus.jsonl');
    await expect(exportCorpus({ query: query(), out, workspaceId })).rejects.toThrow(/inside a git work tree/);
    expect(existsSync(out)).toBe(false);
    expect(() => assertOutsideRepo(join(REPO_ROOT, 'deep/new/dir/x.jsonl'))).toThrow(/inside a git work tree/);
    expect(() => assertOutsideRepo(join(dir, 'ok.jsonl'))).not.toThrow();
  });

  test('the CLI refuses too, and fails on an export of nothing', async () => {
    const urlFile = join(dir, 'dburl');
    await Bun.write(urlFile, process.env.DATABASE_URL!);
    await expect(main(['--db-url-file', urlFile, '--out', join(REPO_ROOT, 'x.jsonl')])).rejects.toThrow(/inside a git work tree/);
    expect(await main(['--db-url-file', urlFile, '--out', join(dir, 'none.jsonl'), '--since', '2999-01-01', '--workspace', workspaceId])).toBe(1);
    expect(await main(['--db-url-file', urlFile, '--out', join(dir, 'cli.jsonl'), '--workspace', workspaceId])).toBe(0);
    expect(readCorpus(join(dir, 'cli.jsonl'))).toHaveLength(seeded.deliveryIds.length);
  });
});

describe('export', () => {
  test('one line per delivery, every kernel table represented', async () => {
    const out = join(dir, 'all.jsonl');
    const r = await exportCorpus({ query: query(), out, workspaceId });
    expect(r.written).toBe(seeded.deliveryIds.length);
    const corpus = readCorpus(out);
    expect(corpus.every((c) => c.transitions.length > 0 && c.facts.length > 0)).toBe(true);
    expect(corpus.some((c) => c.rounds.length > 0)).toBe(true);
    expect(corpus.some((c) => c.attempts.length > 0)).toBe(true);
    expect(corpus.some((c) => c.effects.length > 0)).toBe(true);
    expect(corpus.some((c) => c.gateEvents.length > 0)).toBe(true);
    // An unapplied fact (the merge redelivery) is exported with its delivery.
    expect(corpus.some((c) => c.facts.some((f) => f.appliedTransitionId === null))).toBe(true);
  });

  test('sanitized: no seeded id, SHA, repo, branch, prose or absolute date survives', async () => {
    const text = readFileSync(join(dir, 'all.jsonl'), 'utf8');
    for (const id of [...seeded.deliveryIds, ...seeded.taskIds, workspaceId]) expect(text).not.toContain(id);
    for (const s of seeded.shas) expect(text).not.toContain(s);
    expect(text).not.toContain(SEED_REPO);
    expect(text).not.toContain('acme');
    expect(text).not.toContain(SEED_BRANCH);
    expect(text).not.toContain(SEED_PROSE);
    expect(text).not.toMatch(/\b2026-/);
    expect(text).toContain('[redacted]');
    // Pseudonyms are stable: the same workspace pseudonym on every line.
    const ws = new Set(readCorpus(join(dir, 'all.jsonl')).map((c) => c.delivery.workspaceId));
    expect(ws.size).toBe(1);
  });

  test('--limit, --since and --errors-first', async () => {
    const limited = join(dir, 'limited.jsonl');
    expect((await exportCorpus({ query: query(), out: limited, workspaceId, limit: 2 })).written).toBe(2);
    expect((await exportCorpus({ query: query(), out: join(dir, 'future.jsonl'), workspaceId, since: '2999-01-01' })).written).toBe(0);
    const first = join(dir, 'errors-first.jsonl');
    await exportCorpus({ query: query(), out: first, workspaceId, limit: 2, errorsFirst: true });
    const top = readCorpus(first);
    // Both seeded failures rank above every successful delivery.
    expect(top.map((c) => c.delivery.state).sort()).toEqual(['ESCALATED', 'FAILED']);
    expect(top.find((c) => c.delivery.state === 'ESCALATED')!.outcome).toMatchObject({ ownerTaskStatus: 'failed', gateRefusals: 1 });
    expect(top.flatMap((c) => c.gateEvents.map((g) => g.gate))).toContain('merge_policy');
  });
});

describe('round trip: what the export writes replays through the current kernel', () => {
  test('every seeded delivery is identical, over a non-empty set of steps', async () => {
    const corpus = readCorpus(join(dir, 'all.jsonl'));
    const report = await replayCorpus(corpus, { exec });
    process.stderr.write(`${formatReport(report)}\n`);
    expect(report.deliveries).toBe(seeded.deliveryIds.length);
    expect(report.stepsCompared).toBeGreaterThan(20);
    expect(report.reports.filter((r) => r.result !== 'identical')).toEqual([]);
    if (process.env.KERNEL_REPLAY_WRITE_FIXTURE === '1') {
      writeFileSync(FIXTURE, compactIds(readFileSync(join(dir, 'all.jsonl'), 'utf8')));
      process.stderr.write(`[kernel-corpus] wrote ${FIXTURE}\n`);
    }
  }, 120_000);
});
