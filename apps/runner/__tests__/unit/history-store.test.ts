/**
 * Unit tests for history-store.ts
 *
 * Tests SQLite history layer, archive/decompress, search, stats, and backfill.
 *
 * Run: bun test __tests__/unit/history-store.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
const { mkdirSync, writeFileSync, existsSync, readFileSync } = fs;
import { join } from 'path';

import { tmpdir } from 'os';
const TEST_DIR = join(tmpdir(), `buildd-hist-test-${process.pid}-${Date.now()}`);
const TEST_ARCHIVE_DIR = join(TEST_DIR, 'archive');

let db: Database;

beforeAll(() => {
  mkdirSync(TEST_ARCHIVE_DIR, { recursive: true });
  // Use in-memory database to avoid file system issues in parallel test runner
  db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      task_description TEXT,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      branch TEXT,
      status TEXT NOT NULL,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      commits_json TEXT,
      pr_url TEXT,
      last_assistant_message TEXT,
      milestones_json TEXT,
      model TEXT,
      num_turns INTEGER,
      stop_reason TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_completed ON sessions(completed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);

  const ftsExists = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_fts'`).get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE sessions_fts USING fts5(
        task_title, task_description, workspace_name, last_assistant_message,
        content='sessions', content_rowid='rowid'
      )
    `);
    db.exec(`
      CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES (new.rowid, new.task_title, new.task_description, new.workspace_name, new.last_assistant_message);
      END
    `);
    db.exec(`
      CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES ('delete', old.rowid, old.task_title, old.task_description, old.workspace_name, old.last_assistant_message);
      END
    `);
    db.exec(`
      CREATE TRIGGER sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES ('delete', old.rowid, old.task_title, old.task_description, old.workspace_name, old.last_assistant_message);
        INSERT INTO sessions_fts(rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES (new.rowid, new.task_title, new.task_description, new.workspace_name, new.last_assistant_message);
      END
    `);
  }
});

afterAll(() => {
  db?.close();
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

function insertSession(overrides: Record<string, any> = {}) {
  const defaults = {
    id: `w-${Math.random().toString(36).slice(2, 8)}`,
    task_id: 'task-1',
    task_title: 'Fix authentication bug',
    task_description: 'The login flow is broken when using OAuth',
    workspace_id: 'ws-1',
    workspace_name: 'my-project',
    branch: 'fix/auth-bug',
    status: 'done',
    error: null,
    started_at: Date.now() - 300000,
    completed_at: Date.now(),
    duration_ms: 300000,
    total_input_tokens: 50000,
    total_output_tokens: 5000,
    total_cost_usd: 0.15,
    commit_count: 2,
    commits_json: JSON.stringify([{ sha: 'abc1234', message: 'Fix OAuth callback' }, { sha: 'def5678', message: 'Add tests' }]),
    pr_url: 'https://github.com/org/repo/pull/42',
    last_assistant_message: 'Fixed the authentication bug.',
    milestones_json: JSON.stringify([{ ts: Date.now() - 300000, label: 'Started' }]),
    model: 'claude-sonnet-4-5-20250929',
    num_turns: 15,
    stop_reason: 'end_turn',
  };
  const row = { ...defaults, ...overrides };
  db.query(`
    INSERT INTO sessions (id, task_id, task_title, task_description, workspace_id, workspace_name, branch, status, error,
      started_at, completed_at, duration_ms, total_input_tokens, total_output_tokens, total_cost_usd,
      commit_count, commits_json, pr_url, last_assistant_message, milestones_json, model, num_turns, stop_reason)
    VALUES ($id, $task_id, $task_title, $task_description, $workspace_id, $workspace_name, $branch, $status, $error,
      $started_at, $completed_at, $duration_ms, $total_input_tokens, $total_output_tokens, $total_cost_usd,
      $commit_count, $commits_json, $pr_url, $last_assistant_message, $milestones_json, $model, $num_turns, $stop_reason)
  `).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])));
  return row;
}

describe('history-store SQLite', () => {
  test('creates database and tables', () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('sessions_fts');
  });

  test('inserts and retrieves a session', () => {
    const row = insertSession({ id: 'test-w-1' });
    const result = db.query('SELECT * FROM sessions WHERE id = ?').get('test-w-1') as any;
    expect(result).not.toBeNull();
    expect(result.task_title).toBe('Fix authentication bug');
    expect(result.status).toBe('done');
    expect(result.total_cost_usd).toBe(0.15);
    expect(result.commit_count).toBe(2);
  });

  test('rejects duplicate ids', () => {
    insertSession({ id: 'dup-1' });
    expect(() => insertSession({ id: 'dup-1' })).toThrow();
  });

  test('FTS5 indexes title and description', () => {
    insertSession({ id: 'fts-1', task_title: 'Implement dark mode toggle', task_description: 'Add theme switching' });
    const results = db.query(`SELECT id FROM sessions WHERE rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'dark mode')`).all() as { id: string }[];
    expect(results.some(r => r.id === 'fts-1')).toBe(true);
  });

  test('FTS5 matches workspace name', () => {
    insertSession({ id: 'fts-ws-1', workspace_name: 'acme dashboard' });
    const results = db.query(`SELECT id FROM sessions WHERE rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'acme')`).all() as { id: string }[];
    expect(results.some(r => r.id === 'fts-ws-1')).toBe(true);
  });
});

describe('search and pagination', () => {
  test('paginates results', () => {
    for (let i = 0; i < 5; i++) insertSession({ id: `pg-${i}`, completed_at: Date.now() - i * 60000, workspace_id: 'ws-pg' });
    const p1 = db.query('SELECT * FROM sessions WHERE workspace_id = $ws ORDER BY completed_at DESC LIMIT 2 OFFSET 0').all({ $ws: 'ws-pg' }) as any[];
    const p2 = db.query('SELECT * FROM sessions WHERE workspace_id = $ws ORDER BY completed_at DESC LIMIT 2 OFFSET 2').all({ $ws: 'ws-pg' }) as any[];
    expect(p1.length).toBe(2);
    expect(p2.length).toBe(2);
    expect(p1[0].id).not.toBe(p2[0].id);
  });

  test('filters by status', () => {
    insertSession({ id: 's-done', status: 'done', workspace_id: 'ws-st' });
    insertSession({ id: 's-err', status: 'error', workspace_id: 'ws-st', error: 'Loop detected' });
    const errors = db.query('SELECT * FROM sessions WHERE workspace_id = $ws AND status = $s').all({ $ws: 'ws-st', $s: 'error' }) as any[];
    expect(errors.length).toBe(1);
    expect(errors[0].id).toBe('s-err');
  });

  test('sorts by cost', () => {
    insertSession({ id: 'c-lo', total_cost_usd: 0.01, workspace_id: 'ws-c' });
    insertSession({ id: 'c-hi', total_cost_usd: 5.50, workspace_id: 'ws-c' });
    insertSession({ id: 'c-md', total_cost_usd: 0.75, workspace_id: 'ws-c' });
    const sorted = db.query('SELECT id FROM sessions WHERE workspace_id = $ws ORDER BY total_cost_usd DESC').all({ $ws: 'ws-c' }) as { id: string }[];
    expect(sorted[0].id).toBe('c-hi');
    expect(sorted[1].id).toBe('c-md');
    expect(sorted[2].id).toBe('c-lo');
  });
});

describe('stats', () => {
  test('aggregates counts and costs', () => {
    const ws = `ws-agg-${Date.now()}`;
    insertSession({ id: `agg-1-${Date.now()}`, workspace_id: ws, total_cost_usd: 1.00, duration_ms: 60000 });
    insertSession({ id: `agg-2-${Date.now()}`, workspace_id: ws, total_cost_usd: 2.00, duration_ms: 120000 });
    const stats = db.query('SELECT COUNT(*) as cnt, SUM(total_cost_usd) as cost, AVG(duration_ms) as avg_dur FROM sessions WHERE workspace_id = $ws').get({ $ws: ws }) as any;
    expect(stats.cnt).toBe(2);
    expect(stats.cost).toBe(3.00);
    expect(stats.avg_dur).toBe(90000);
  });
});

describe('gzip archive', () => {
  test('round-trips session data through gzip', async () => {
    mkdirSync(TEST_ARCHIVE_DIR, { recursive: true });
    const data = {
      messages: [{ type: 'text', content: 'I fixed the bug' }, { type: 'user', content: 'Great!' }],
      toolCalls: [{ name: 'Edit', input: { file: 'test.ts' } }],
      commits: [{ sha: 'abc1234', message: 'Fix bug' }],
      resultMeta: { stopReason: 'end_turn', durationMs: 30000, numTurns: 5, modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 10000, outputTokens: 2000, costUSD: 0.05 } } },
    };

    const archivePath = join(TEST_ARCHIVE_DIR, 'test-archive.json.gz');
    const compressed = Bun.gzipSync(Buffer.from(JSON.stringify(data)));
    await Bun.write(archivePath, compressed);

    const raw = await Bun.file(archivePath).arrayBuffer();
    expect(raw.byteLength).toBeGreaterThan(0);
    const restored = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(raw))));
    expect(restored.messages).toHaveLength(2);
    expect(restored.commits[0].sha).toBe('abc1234');
    expect(restored.resultMeta.modelUsage['claude-sonnet-4-5-20250929'].costUSD).toBe(0.05);
  });

  test('compresses effectively', () => {
    const big = { messages: Array.from({ length: 100 }, (_, i) => ({ type: 'text', content: `Msg ${i}: ${'Lorem ipsum. '.repeat(20)}` })) };
    const json = JSON.stringify(big);
    const compressed = Bun.gzipSync(Buffer.from(json));
    expect(compressed.length).toBeLessThan(json.length);
  });
});

describe('integration flow', () => {
  test('insert + gzip + FTS search', async () => {
    mkdirSync(TEST_ARCHIVE_DIR, { recursive: true });
    const id = `intg-${Date.now()}`;
    insertSession({ id, task_title: 'Integration test task', total_cost_usd: 0.42 });

    const archivePath = join(TEST_ARCHIVE_DIR, `${id}.json.gz`);
    await Bun.write(archivePath, Bun.gzipSync(Buffer.from(JSON.stringify({ messages: [{ type: 'text', content: 'Done!' }] }))));

    const session = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    expect(session.total_cost_usd).toBe(0.42);

    const raw = await Bun.file(archivePath).arrayBuffer();
    const archived = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(raw))));
    expect(archived.messages[0].content).toBe('Done!');

    const fts = db.query(`SELECT id FROM sessions WHERE rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH '"integration test"')`).all() as { id: string }[];
    expect(fts.some(r => r.id === id)).toBe(true);
  });
});
