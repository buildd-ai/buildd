/**
 * History Store — SQLite-backed durable session history
 *
 * Stores completed worker sessions in ~/.buildd/history.db (WAL mode).
 * Full session data is gzipped and archived to ~/.buildd/archive/{id}.json.gz.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { LocalWorker, ResultMeta } from './types';

const BUILDD_DIR = join(homedir(), '.buildd');
const DB_PATH = join(BUILDD_DIR, 'history.db');
const ARCHIVE_DIR = join(BUILDD_DIR, 'archive');
const WORKERS_DIR = join(BUILDD_DIR, 'workers');

// Archive TTL: 90 days
const ARCHIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

let db: Database | null = null;

function ensureDirs() {
  if (!existsSync(BUILDD_DIR)) mkdirSync(BUILDD_DIR, { recursive: true });
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function getDb(): Database {
  if (db) return db;

  ensureDirs();
  db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  // Create tables
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

  // Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_completed ON sessions(completed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);

  // FTS5 for full-text search
  // Check if FTS table exists before creating (can't use IF NOT EXISTS with virtual tables in all SQLite versions)
  const ftsExists = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_fts'`).get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE sessions_fts USING fts5(
        task_title, task_description, workspace_name, last_assistant_message,
        content='sessions', content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES (new.rowid, new.task_title, new.task_description, new.workspace_name, new.last_assistant_message);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES ('delete', old.rowid, old.task_title, old.task_description, old.workspace_name, old.last_assistant_message);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES ('delete', old.rowid, old.task_title, old.task_description, old.workspace_name, old.last_assistant_message);
        INSERT INTO sessions_fts(rowid, task_title, task_description, workspace_name, last_assistant_message)
        VALUES (new.rowid, new.task_title, new.task_description, new.workspace_name, new.last_assistant_message);
      END
    `);
  }

  return db;
}

/** Extract cost/token data from a worker's resultMeta */
function extractMetrics(worker: LocalWorker): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  model: string | null;
  numTurns: number;
  stopReason: string | null;
  durationMs: number;
} {
  const meta = worker.resultMeta;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let model: string | null = null;

  if (meta?.modelUsage) {
    const models = Object.keys(meta.modelUsage);
    // Primary model = most tokens used
    let maxTokens = 0;
    for (const [m, usage] of Object.entries(meta.modelUsage)) {
      const tokens = usage.inputTokens + usage.outputTokens;
      if (tokens > maxTokens) {
        maxTokens = tokens;
        model = m;
      }
      totalInputTokens += usage.inputTokens + (usage.cacheReadInputTokens || 0);
      totalOutputTokens += usage.outputTokens;
      totalCostUsd += usage.costUSD || 0;
    }
  }

  // Duration: use SDK's durationMs if available, otherwise compute from timestamps
  const durationMs = meta?.durationMs ||
    (worker.completedAt && worker.lastActivity
      ? worker.completedAt - (worker.milestones[0]?.ts || worker.lastActivity)
      : 0);

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    model,
    numTurns: meta?.numTurns || 0,
    stopReason: meta?.stopReason || null,
    durationMs,
  };
}

/** Archive a completed/errored worker session to SQLite + gzip */
export function archiveSession(worker: LocalWorker): void {
  try {
    const db = getDb();

    // Skip if already archived
    const existing = db.query('SELECT id FROM sessions WHERE id = ?').get(worker.id);
    if (existing) return;

    // Only archive terminal states
    if (worker.status !== 'done' && worker.status !== 'error') return;

    const metrics = extractMetrics(worker);

    // Find PR URL from commits or milestones
    let prUrl: string | null = null;
    for (const m of worker.milestones) {
      if ('label' in m && m.label.includes('PR #')) {
        // Extract URL from milestone label if present
        const match = m.label.match(/https?:\/\/\S+/);
        if (match) prUrl = match[0];
      }
    }

    const startedAt = worker.milestones.length > 0
      ? worker.milestones[0].ts
      : (worker.completedAt || Date.now()) - (metrics.durationMs || 0);

    // Insert session row
    db.query(`
      INSERT INTO sessions (
        id, task_id, task_title, task_description,
        workspace_id, workspace_name, branch, status, error,
        started_at, completed_at, duration_ms,
        total_input_tokens, total_output_tokens, total_cost_usd,
        commit_count, commits_json, pr_url,
        last_assistant_message, milestones_json,
        model, num_turns, stop_reason
      ) VALUES (
        $id, $taskId, $taskTitle, $taskDescription,
        $workspaceId, $workspaceName, $branch, $status, $error,
        $startedAt, $completedAt, $durationMs,
        $totalInputTokens, $totalOutputTokens, $totalCostUsd,
        $commitCount, $commitsJson, $prUrl,
        $lastAssistantMessage, $milestonesJson,
        $model, $numTurns, $stopReason
      )
    `).run({
      $id: worker.id,
      $taskId: worker.taskId,
      $taskTitle: worker.taskTitle,
      $taskDescription: worker.taskDescription || null,
      $workspaceId: worker.workspaceId,
      $workspaceName: worker.workspaceName,
      $branch: worker.branch || null,
      $status: worker.status,
      $error: worker.error || null,
      $startedAt: startedAt,
      $completedAt: worker.completedAt || null,
      $durationMs: metrics.durationMs,
      $totalInputTokens: metrics.totalInputTokens,
      $totalOutputTokens: metrics.totalOutputTokens,
      $totalCostUsd: metrics.totalCostUsd,
      $commitCount: worker.commits.length,
      $commitsJson: worker.commits.length > 0 ? JSON.stringify(worker.commits) : null,
      $prUrl: prUrl,
      $lastAssistantMessage: worker.lastAssistantMessage || null,
      $milestonesJson: worker.milestones.length > 0 ? JSON.stringify(worker.milestones) : null,
      $model: metrics.model,
      $numTurns: metrics.numTurns,
      $stopReason: metrics.stopReason,
    });

    // Archive full session data as gzip
    const archiveData = {
      messages: worker.messages,
      toolCalls: worker.toolCalls,
      milestones: worker.milestones,
      commits: worker.commits,
      output: worker.output,
      resultMeta: worker.resultMeta,
      teamState: worker.teamState,
      promptSuggestions: worker.promptSuggestions,
    };

    const compressed = Bun.gzipSync(
      Buffer.from(JSON.stringify(archiveData))
    );
    Bun.write(join(ARCHIVE_DIR, `${worker.id}.json.gz`), compressed);

  } catch (err) {
    // Non-fatal — don't crash the worker lifecycle
    console.error(`[HistoryStore] Failed to archive session ${worker.id}:`, err);
  }
}

export interface SessionRow {
  id: string;
  task_id: string;
  task_title: string;
  task_description: string | null;
  workspace_id: string;
  workspace_name: string;
  branch: string | null;
  status: string;
  error: string | null;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  commit_count: number;
  commits_json: string | null;
  pr_url: string | null;
  last_assistant_message: string | null;
  milestones_json: string | null;
  model: string | null;
  num_turns: number | null;
  stop_reason: string | null;
}

export interface SearchOptions {
  q?: string;
  workspace?: string;
  status?: string;
  from?: number;   // Unix timestamp ms
  to?: number;     // Unix timestamp ms
  sort?: 'completed_at' | 'duration_ms' | 'total_cost_usd' | 'started_at';
  dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface SearchResult {
  sessions: SessionRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Search sessions with full-text search, filters, and pagination */
export function searchSessions(opts: SearchOptions = {}): SearchResult {
  const db = getDb();
  const limit = Math.min(opts.limit || 20, 100);
  const page = Math.max(opts.page || 1, 1);
  const offset = (page - 1) * limit;
  const sort = opts.sort || 'completed_at';
  const dir = opts.dir || 'desc';

  // Validate sort column (prevent injection)
  const validSorts = ['completed_at', 'duration_ms', 'total_cost_usd', 'started_at'];
  const sortCol = validSorts.includes(sort) ? sort : 'completed_at';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.q) {
    // Use FTS5 for text search
    conditions.push(`sessions.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH $q)`);
    params.$q = opts.q;
  }

  if (opts.workspace) {
    conditions.push(`workspace_id = $workspace`);
    params.$workspace = opts.workspace;
  }

  if (opts.status) {
    conditions.push(`status = $status`);
    params.$status = opts.status;
  }

  if (opts.from) {
    conditions.push(`completed_at >= $from`);
    params.$from = opts.from;
  }

  if (opts.to) {
    conditions.push(`completed_at <= $to`);
    params.$to = opts.to;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countRow = db.query(`SELECT COUNT(*) as cnt FROM sessions ${whereClause}`).get(params) as { cnt: number };
  const total = countRow?.cnt || 0;

  // Fetch page
  const sessions = db.query(
    `SELECT * FROM sessions ${whereClause} ORDER BY ${sortCol} ${sortDir} LIMIT $limit OFFSET $offset`
  ).all({ ...params, $limit: limit, $offset: offset }) as SessionRow[];

  return {
    sessions,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/** Get a single session by worker ID */
export function getSession(workerId: string): SessionRow | null {
  const db = getDb();
  return db.query('SELECT * FROM sessions WHERE id = ?').get(workerId) as SessionRow | null;
}

/** Get archived session data (decompressed) */
export function getArchivedData(workerId: string): any | null {
  const archivePath = join(ARCHIVE_DIR, `${workerId}.json.gz`);
  if (!existsSync(archivePath)) return null;

  try {
    const compressed = readFileSync(archivePath);
    const decompressed = Bun.gunzipSync(compressed);
    return JSON.parse(new TextDecoder().decode(decompressed));
  } catch (err) {
    console.error(`[HistoryStore] Failed to decompress archive for ${workerId}:`, err);
    return null;
  }
}

export interface HistoryStats {
  totalSessions: number;
  totalCost: number;
  avgDurationMs: number;
  byWorkspace: Array<{ workspace_id: string; workspace_name: string; count: number; total_cost: number }>;
  byStatus: Array<{ status: string; count: number }>;
  byModel: Array<{ model: string; count: number; total_cost: number }>;
}

/** Get aggregate stats */
export function getStats(): HistoryStats {
  const db = getDb();

  const overview = db.query(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM sessions
  `).get() as any;

  const byWorkspace = db.query(`
    SELECT workspace_id, workspace_name, COUNT(*) as count, COALESCE(SUM(total_cost_usd), 0) as total_cost
    FROM sessions GROUP BY workspace_id ORDER BY count DESC LIMIT 20
  `).all() as any[];

  const byStatus = db.query(`
    SELECT status, COUNT(*) as count FROM sessions GROUP BY status
  `).all() as any[];

  const byModel = db.query(`
    SELECT model, COUNT(*) as count, COALESCE(SUM(total_cost_usd), 0) as total_cost
    FROM sessions WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC
  `).all() as any[];

  return {
    totalSessions: overview?.total_sessions || 0,
    totalCost: overview?.total_cost || 0,
    avgDurationMs: overview?.avg_duration_ms || 0,
    byWorkspace,
    byStatus,
    byModel,
  };
}

/** Backfill: scan existing worker JSON files for completed workers not already in SQLite */
export function backfillFromWorkerFiles(): number {
  if (!existsSync(WORKERS_DIR)) return 0;

  let backfilled = 0;
  const db = getDb();

  try {
    const files = readdirSync(WORKERS_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const raw = readFileSync(join(WORKERS_DIR, file), 'utf-8');
        const data = JSON.parse(raw);

        // Only backfill terminal states
        if (data.status !== 'done' && data.status !== 'error') continue;

        // Skip if already in DB
        const exists = db.query('SELECT id FROM sessions WHERE id = ?').get(data.id);
        if (exists) continue;

        // Reconstruct minimal LocalWorker for archiveSession
        const worker: LocalWorker = {
          id: data.id,
          taskId: data.taskId,
          taskTitle: data.taskTitle || 'Unknown',
          taskDescription: data.taskDescription,
          workspaceId: data.workspaceId || '',
          workspaceName: data.workspaceName || 'Unknown',
          branch: data.branch || '',
          status: data.status,
          error: data.error,
          completedAt: data.completedAt || data._savedAt,
          lastActivity: data.lastActivity || data._savedAt || Date.now(),
          messages: data.messages || [],
          milestones: data.milestones || [],
          toolCalls: data.toolCalls || [],
          commits: data.commits || [],
          output: data.output || [],
          lastAssistantMessage: data.lastAssistantMessage,
          // Transient defaults
          hasNewActivity: false,
          currentAction: '',
          subagentTasks: [],
          checkpoints: [],
          checkpointEvents: new Set(),
          phaseText: null,
          phaseStart: null,
          phaseToolCount: 0,
          phaseTools: [],
        };

        archiveSession(worker);
        backfilled++;
      } catch {
        // Skip unparseable files
      }
    }
  } catch (err) {
    console.error('[HistoryStore] Backfill error:', err);
  }

  return backfilled;
}

/** Initialize history store: create tables, backfill, clean old archives */
export function initHistory(): void {
  try {
    getDb(); // Ensures tables are created

    // Backfill from existing worker files
    const count = backfillFromWorkerFiles();
    if (count > 0) {
      console.log(`[HistoryStore] Backfilled ${count} sessions from worker files`);
    }

    // Clean old archives
    cleanupOldArchives();

    const stats = getStats();
    console.log(`[HistoryStore] ${stats.totalSessions} sessions indexed, $${stats.totalCost.toFixed(2)} total cost`);
  } catch (err) {
    console.error('[HistoryStore] Init failed:', err);
  }
}

/** Remove archives older than TTL */
function cleanupOldArchives(): void {
  if (!existsSync(ARCHIVE_DIR)) return;

  const now = Date.now();
  try {
    for (const file of readdirSync(ARCHIVE_DIR)) {
      if (!file.endsWith('.json.gz')) continue;
      const filePath = join(ARCHIVE_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > ARCHIVE_TTL_MS) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}

/** Close the database connection (for clean shutdown) */
export function closeHistory(): void {
  if (db) {
    db.close();
    db = null;
  }
}
