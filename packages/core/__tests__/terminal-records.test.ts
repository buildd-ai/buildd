/**
 * `recordSessionTerminal` — the terminal-record ledger writer.
 *
 * Mirrors `gate-events.test.ts`'s coverage: the exit cause must go through the
 * shared normalizer, and a broken insert must never reach the request path.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

interface InsertedRow {
  workerId: string;
  taskId: string | null;
  workspaceId: string | null;
  outcome: string;
  exitCause: string | null;
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  durationMs: number | null;
  shipped: boolean;
  summaryProvenance: string | null;
  detail: Record<string, unknown> | null;
}

let inserted: InsertedRow[] = [];
let insertShouldThrow = false;
/** null = the conflict-do-nothing path found an existing row and returned nothing. */
let returnedRow: { id: string } | null = { id: 'row-1' };

mock.module('../db/client', () => ({
  db: {
    insert: () => ({
      values: (row: InsertedRow) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (insertShouldThrow) throw new Error('relation "worker_terminal_records" does not exist');
            inserted.push(row);
            return returnedRow ? [returnedRow] : [];
          },
        }),
      }),
    }),
  },
}));

const { recordSessionTerminal, TERMINAL_OUTCOMES } = await import('../terminal-records');

const WS = '11111111-2222-4333-8444-555555555555';
const TASK = '99999999-8888-4777-8666-555555555555';
const WORKER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  inserted = [];
  insertShouldThrow = false;
  returnedRow = { id: 'row-1' };
});

describe('TERMINAL_OUTCOMES', () => {
  it('is the vocabulary this table writes', () => {
    expect(TERMINAL_OUTCOMES).toEqual(['completed', 'failed', 'refused', 'crashed']);
  });
});

describe('recordSessionTerminal', () => {
  it('writes exactly one row with the fields the caller declared', async () => {
    const id = await recordSessionTerminal({
      workerId: WORKER,
      taskId: TASK,
      workspaceId: WS,
      outcome: 'completed',
      turns: 12,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.42,
      durationMs: 60_000,
      shipped: true,
      summaryProvenance: 'agent',
    });

    expect(id).toBe('row-1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].workerId).toBe(WORKER);
    expect(inserted[0].taskId).toBe(TASK);
    expect(inserted[0].workspaceId).toBe(WS);
    expect(inserted[0].outcome).toBe('completed');
    expect(inserted[0].turns).toBe(12);
    expect(inserted[0].costUsd).toBe('0.42');
    expect(inserted[0].shipped).toBe(true);
    expect(inserted[0].summaryProvenance).toBe('agent');
  });

  it('normalizes the exit cause so one failure family is one signature, not N', async () => {
    const a = "Task PR head 'buildd_ed211c59-consolidate-the-create-pr-bran' does not match this worker's own branch ('buildd_ed211c59-consolidate-the-create-pr-bran-wf4817cb0').";
    const b = "Task PR head 'mission/spec-conformance-the-ledger-f02e0dc0-wcda33d93' does not match this worker's own branch ('mission/spec-conformance-the-ledger-f02e0dc0').";

    for (const exitCause of [a, b]) {
      await recordSessionTerminal({ workerId: WORKER, outcome: 'refused', exitCause });
    }

    expect(inserted).toHaveLength(2);
    expect(inserted[0].exitCause).toBe(inserted[1].exitCause);
    expect(inserted[0].exitCause).toContain("'<id>'");
  });

  it('leaves exitCause null when none is given rather than normalizing an empty string', async () => {
    await recordSessionTerminal({ workerId: WORKER, outcome: 'completed' });
    expect(inserted[0].exitCause).toBeNull();
  });

  it('resolves without throwing when the insert fails, and reports the miss', async () => {
    insertShouldThrow = true;
    // No try/catch here on purpose: a rejected promise here is the bug this
    // test exists to catch, because every call site fires without awaiting.
    const id = await recordSessionTerminal({ workerId: WORKER, outcome: 'crashed' });
    expect(id).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('dedupes a repeat write for the same worker via onConflictDoNothing', async () => {
    returnedRow = null; // simulates the unique index already holding a row for this worker
    const id = await recordSessionTerminal({ workerId: WORKER, outcome: 'failed' });
    expect(id).toBeNull();
    expect(inserted).toHaveLength(1); // the attempt is still made — the DB decides
  });

  it('drops non-UUID relation hints rather than failing the insert on them', async () => {
    await recordSessionTerminal({
      workerId: WORKER,
      outcome: 'completed',
      workspaceId: 'buildd',
      taskId: 'not-a-uuid',
    });
    expect(inserted[0].workspaceId).toBeNull();
    expect(inserted[0].taskId).toBeNull();
  });

  it('bounds a runaway detail payload instead of storing it whole', async () => {
    await recordSessionTerminal({
      workerId: WORKER,
      outcome: 'refused',
      detail: { blob: 'x'.repeat(10_000) },
    });
    expect(inserted[0].detail?.truncated).toBe(true);
    expect(JSON.stringify(inserted[0].detail).length).toBeLessThan(6000);
  });

  it('rejects a negative cost/turn value rather than storing a nonsense measurement', async () => {
    await recordSessionTerminal({
      workerId: WORKER,
      outcome: 'completed',
      turns: -5,
      costUsd: -1,
      inputTokens: -100,
    });
    expect(inserted[0].turns).toBeNull();
    expect(inserted[0].costUsd).toBeNull();
    expect(inserted[0].inputTokens).toBeNull();
  });

  it('defaults shipped to false and summaryProvenance/detail to null', async () => {
    await recordSessionTerminal({ workerId: WORKER, outcome: 'crashed' });
    expect(inserted[0].shipped).toBe(false);
    expect(inserted[0].summaryProvenance).toBeNull();
    expect(inserted[0].detail).toBeNull();
  });
});
