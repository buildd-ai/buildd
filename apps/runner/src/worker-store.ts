import * as fs from 'fs';
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } = fs;
import { join } from 'path';
import { resolveBuilddHome } from './buildd-home';
import type { LocalWorker, CheckpointEventType } from './types';
import { teardownStableCodexHome } from './codex-auth';
import { sessionLog } from './session-logger';

/**
 * Best-effort terminal teardown of a Codex worker's stable CODEX_HOME when its
 * persisted file is being expired/removed. Only fires for Codex workers; no-op
 * (and never throws) otherwise. This is the truest terminal point — past the
 * 24h follow-up TTL, the resumable sessions are no longer needed.
 */
function teardownCodexHomeForExpired(data: { id?: unknown; taskBackend?: unknown }): void {
  if (data.taskBackend === 'codex' && typeof data.id === 'string') {
    teardownStableCodexHome(data.id);
  }
}

/**
 * Store root, resolved once on FIRST USE — not at module load.
 *
 * Module-load resolution made this module unredirectable from a test: a
 * `BUILDD_HOME` set in a `beforeAll` (or injected by a test runner that imports
 * the module transitively) arrived after the import had already baked the path
 * in. The unit suite therefore wrote its fixture records into the operator's
 * real `~/.buildd/workers`, where they were indistinguishable from fleet data.
 *
 * Memoised because this sits on the persist hot path, and because prod
 * behaviour must stay byte-identical: same precedence, same value, resolved
 * once. `__resetWorkerStoreRoot` is test-only.
 */
let workersDirCache: string | null = null;

function workersDir(): string {
  if (workersDirCache === null) {
    workersDirCache = join(resolveBuilddHome(), 'workers');
  }
  return workersDirCache;
}

/** Test-only: forget the memoised root so a new BUILDD_HOME takes effect. */
export function __resetWorkerStoreRoot(): void {
  workersDirCache = null;
}

// Fields to persist (excludes transient UI state)
const PERSISTED_FIELDS = [
  'id', 'taskId', 'taskTitle', 'taskDescription', 'taskMode', 'taskBackend', 'workspaceId', 'workspaceName',
  'branch', 'status', 'error', 'completedAt', 'startedAt', 'lastActivity', 'sessionId', 'codexThreadId',
  'waitingFor',
  // So a resume after a runner restart keeps the model the session ran on.
  'sessionModel',
  'messages', 'milestones', 'toolCalls', 'commits',
  'output', 'teamState', 'worktreePath', 'promptSuggestions', 'lastAssistantMessage',
  // Read by history-store's backfill so an archived session keeps its usage,
  // model and PR URL. Not restored onto live workers by loadAllWorkers.
  'resultMeta', 'prUrl', 'reportedModel',
] as const;

// Bounds to keep files reasonable
const MAX_MESSAGES = 200;
const MAX_TOOL_CALLS = 200;
const MAX_OUTPUT = 100;
const MAX_MILESTONES = 30;
const MAX_COMMITS = 50;
const MAX_TOOL_INPUT_LENGTH = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PersistedWorker {
  _version: number;
  _savedAt: number;
  [key: string]: unknown;
}

/**
 * Age reference for the TTL: when the worker last DID something, not when its
 * file was last written.
 *
 * `_savedAt` is re-stamped by `saveWorker` on every persist, and both the
 * batched dirty-flush and the `killedByRestart` rewrite below persist records
 * that have done nothing for days — so a `_savedAt` TTL renewed itself on every
 * contact and nothing ever expired. `MAX_AGE_MS` and the "24h history" the
 * runner advertises both mean activity age, so measure that.
 *
 * `_savedAt` stays as the fallback for legacy files written before
 * `completedAt`/`lastActivity` were persisted — the same precedence
 * `history-store.ts` already uses.
 */
export function activityAt(data: Partial<PersistedWorker>): number {
  const completed = typeof data.completedAt === 'number' ? data.completedAt : 0;
  const active = typeof data.lastActivity === 'number' ? data.lastActivity : 0;
  return Math.max(completed, active) || (typeof data._savedAt === 'number' ? data._savedAt : 0);
}

function ensureDir() {
  if (!existsSync(workersDir())) {
    mkdirSync(workersDir(), { recursive: true });
  }
}

function workerPath(workerId: string): string {
  return join(workersDir(), `${workerId}.json`);
}

function tmpPath(workerId: string): string {
  return join(workersDir(), `${workerId}.json.tmp`);
}

// Workers whose terminal error has already been written to their own session
// log — 59% of failed workers had NO error-level entry in their own log
// (the reason lived only in this state file), and the two files shared no
// correlation key. Hooking this single choke point (rather than the ~25
// `worker.error = ...` assignment sites scattered across workers.ts,
// recovery.ts, hook-factory.ts, pusher-manager.ts and worker-sync.ts) means
// it fires exactly when the state file holding the reason is written, and
// the guard here keeps a worker that gets saved repeatedly in the same
// terminal state from duplicating the entry.
const loggedTerminalErrors = new Set<string>();

/** Truncate tool call inputs to limit file size */
function truncateToolCalls(toolCalls: Array<{ name: string; timestamp: number; input?: any }>): Array<{ name: string; timestamp: number; input?: any }> {
  return toolCalls.map(tc => {
    if (!tc.input) return tc;
    const inputStr = JSON.stringify(tc.input);
    if (inputStr.length <= MAX_TOOL_INPUT_LENGTH) return tc;
    // Truncate to a simple summary
    return { ...tc, input: { _truncated: inputStr.slice(0, MAX_TOOL_INPUT_LENGTH) } };
  });
}

/** Save a worker's state to disk (atomic write) */
export function saveWorker(worker: LocalWorker): void {
  ensureDir();

  const data: PersistedWorker = {
    _version: 1,
    _savedAt: Date.now(),
  };

  // Copy persisted fields with bounds
  for (const field of PERSISTED_FIELDS) {
    const value = worker[field as keyof LocalWorker];
    if (value !== undefined) {
      data[field] = value;
    }
  }

  // Apply bounds
  if (data.messages && Array.isArray(data.messages)) {
    data.messages = (data.messages as any[]).slice(-MAX_MESSAGES);
  }
  if (data.toolCalls && Array.isArray(data.toolCalls)) {
    data.toolCalls = truncateToolCalls((data.toolCalls as any[]).slice(-MAX_TOOL_CALLS));
  }
  if (data.output && Array.isArray(data.output)) {
    data.output = (data.output as any[]).slice(-MAX_OUTPUT);
  }
  if (data.milestones && Array.isArray(data.milestones)) {
    data.milestones = (data.milestones as any[]).slice(-MAX_MILESTONES);
  }
  if (data.commits && Array.isArray(data.commits)) {
    data.commits = (data.commits as any[]).slice(-MAX_COMMITS);
  }

  const filePath = workerPath(worker.id);
  const tempPath = tmpPath(worker.id);

  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2));
    renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[WorkerStore] Failed to save worker ${worker.id}:`, err);
    // Clean up temp file if rename failed
    try { unlinkSync(tempPath); } catch {}
  }

  if (worker.status === 'error' && worker.error) {
    if (!loggedTerminalErrors.has(worker.id)) {
      loggedTerminalErrors.add(worker.id);
      sessionLog(worker.id, 'error', 'terminal_error', worker.error, worker.taskId);
    }
  } else {
    // Left the error state (recovered, or a fresh attempt reusing the id) —
    // a later terminal error is a new occurrence and should log again.
    loggedTerminalErrors.delete(worker.id);
  }
}

/** Load all persisted workers from disk */
export function loadAllWorkers(): LocalWorker[] {
  if (!existsSync(workersDir())) return [];

  const workers: LocalWorker[] = [];
  const now = Date.now();
  let files: string[];

  try {
    files = readdirSync(workersDir());
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = join(workersDir(), file);

    // Clean up orphaned .tmp files
    if (file.endsWith('.tmp')) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    if (!file.endsWith('.json')) continue;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as PersistedWorker;

      // Skip files whose last ACTIVITY is older than 24h
      const age = activityAt(data);
      if (age && now - age > MAX_AGE_MS) {
        try { unlinkSync(filePath); } catch {}
        teardownCodexHomeForExpired(data);
        continue;
      }

      // Any worker persisted as 'working' is a zombie at load time — Claude sessions
      // cannot survive a runner restart. Mark all of them as error immediately.
      // Previously we only caught workers with no activity, but even workers mid-session
      // are dead after a restart and would block concurrency indefinitely if left as working.
      // `killedByRestart` is a transient in-memory marker (never written to
      // disk) telling restoreWorkersFromDisk that this row still needs its
      // terminal state reported to the server. Rewriting the status here used to
      // silently disable that notification, because the caller keyed off
      // status === 'working' and by then it was already 'error' — so every
      // restart left every in-flight worker's server row at 'running' until the
      // reaper expired it.
      let killedByRestart = false;
      if (data.status === 'working') {
        data.status = 'error';
        data.error = 'Killed: runner restarted, in-flight session terminated';
        // `_savedAt` deliberately NOT bumped: this is a status correction, not
        // activity. Bumping it renewed the 24h TTL on every runner restart,
        // which is how records (including leaked test fixtures) became immortal.
        killedByRestart = true;
        try {
          writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch {}
      }

      // Reconstruct LocalWorker with transient defaults
      const worker: LocalWorker = {
        id: data.id as string,
        taskId: data.taskId as string,
        taskTitle: data.taskTitle as string,
        taskDescription: data.taskDescription as string | undefined,
        taskMode: data.taskMode as string | undefined,
        workspaceId: data.workspaceId as string,
        workspaceName: data.workspaceName as string,
        branch: data.branch as string,
        status: data.status as LocalWorker['status'],
        ...(killedByRestart ? { killedByRestart: true } : {}),
        taskBackend: data.taskBackend as LocalWorker['taskBackend'],
        error: data.error as string | undefined,
        completedAt: data.completedAt as number | undefined,
        startedAt: (data.startedAt as number) || (data.lastActivity as number),  // Fallback for workers saved before startedAt existed
        lastActivity: data.lastActivity as number,
        sessionId: data.sessionId as string | undefined,
        codexThreadId: data.codexThreadId as string | undefined,
        waitingFor: data.waitingFor as LocalWorker['waitingFor'],
        messages: (data.messages as LocalWorker['messages']) || [],
        milestones: (data.milestones as LocalWorker['milestones']) || [],
        toolCalls: (data.toolCalls as LocalWorker['toolCalls']) || [],
        commits: (data.commits as LocalWorker['commits']) || [],
        output: (data.output as LocalWorker['output']) || [],
        teamState: data.teamState as LocalWorker['teamState'],
        worktreePath: data.worktreePath as string | undefined,
        promptSuggestions: data.promptSuggestions as string[] | undefined,
        lastAssistantMessage: data.lastAssistantMessage as string | undefined,
        // Transient defaults
        hasNewActivity: false,
        currentAction: '',
        subagentTasks: [],
        checkpoints: [],
        checkpointEvents: new Set<CheckpointEventType>(
          ((data.milestones as any[]) || [])
            .filter((m: any) => m.type === 'checkpoint')
            .map((m: any) => m.event as CheckpointEventType)
        ),
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };

      workers.push(worker);
    } catch (err) {
      console.error(`[WorkerStore] Failed to parse ${file}, removing:`, err);
      try { unlinkSync(filePath); } catch {}
    }
  }

  return workers;
}

/** Load a single worker from disk by ID (returns null if not found or expired) */
export function loadWorker(workerId: string): LocalWorker | null {
  const filePath = workerPath(workerId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as PersistedWorker;

    // Skip if expired (activity age, not write age — see activityAt)
    const age = activityAt(data);
    if (age && Date.now() - age > MAX_AGE_MS) {
      try { unlinkSync(filePath); } catch {}
      teardownCodexHomeForExpired(data);
      return null;
    }

    return {
      id: data.id as string,
      taskId: data.taskId as string,
      taskTitle: data.taskTitle as string,
      taskDescription: data.taskDescription as string | undefined,
      taskMode: data.taskMode as string | undefined,
      workspaceId: data.workspaceId as string,
      workspaceName: data.workspaceName as string,
      branch: data.branch as string,
      status: data.status as LocalWorker['status'],
      taskBackend: data.taskBackend as LocalWorker['taskBackend'],
      error: data.error as string | undefined,
      completedAt: data.completedAt as number | undefined,
      startedAt: (data.startedAt as number) || (data.lastActivity as number),
      lastActivity: data.lastActivity as number,
      sessionId: data.sessionId as string | undefined,
      codexThreadId: data.codexThreadId as string | undefined,
      waitingFor: data.waitingFor as LocalWorker['waitingFor'],
      messages: (data.messages as LocalWorker['messages']) || [],
      milestones: (data.milestones as LocalWorker['milestones']) || [],
      toolCalls: (data.toolCalls as LocalWorker['toolCalls']) || [],
      commits: (data.commits as LocalWorker['commits']) || [],
      output: (data.output as LocalWorker['output']) || [],
      teamState: data.teamState as LocalWorker['teamState'],
      worktreePath: data.worktreePath as string | undefined,
      promptSuggestions: data.promptSuggestions as string[] | undefined,
      lastAssistantMessage: data.lastAssistantMessage as string | undefined,
      hasNewActivity: false,
      currentAction: '',
      subagentTasks: [],
      checkpoints: [],
      checkpointEvents: new Set<CheckpointEventType>(
        ((data.milestones as any[]) || [])
          .filter((m: any) => m.type === 'checkpoint')
          .map((m: any) => m.event as CheckpointEventType)
      ),
      phaseText: null,
      phaseStart: null,
      phaseToolCount: 0,
      phaseTools: [],
    };
  } catch {
    return null;
  }
}

// `getWorkers()` (workers.ts) merges in-memory workers with the done/error
// workers still on disk (24h history). It's called from several HTTP route
// handlers — `GET /health`, `GET /api/workers`, the `GET /api/events` SSE
// init payload, `POST /api/update` — plus a 60s watchdog and the periodic
// reconcile pass. Before this cache, every one of those calls paid a full
// `readdirSync` + JSON.parse of the whole store — a 23-day audit of the live
// runner found several hundred files there routinely, so this was the actual
// bottleneck on hot paths. (Pusher event handlers use a separate, already-
// cheap in-memory Map callback of the same name and were never part of this.)
//
// Bounded instead of invalidated on write: the disk-only terminal set only
// gains members when a worker is evicted from memory (a 5-minute timer) or
// restored at startup, so a short TTL trades at most a few seconds of
// staleness on a history listing for turning O(calls x files) into
// O(files / ttl).
const TERMINAL_CACHE_TTL_MS = 5_000;
let terminalWorkersCache: { workers: LocalWorker[]; expiresAt: number } | null = null;
let diskScanCountForTests = 0;

/**
 * Cached, filtered view of `loadAllWorkers()` for hot paths that only need
 * the terminal (done/error) disk history, not the live workers already held
 * in memory. `now` is injectable for deterministic tests.
 */
export function loadTerminalWorkersCached(now: number = Date.now()): LocalWorker[] {
  if (!terminalWorkersCache || terminalWorkersCache.expiresAt <= now) {
    diskScanCountForTests += 1;
    terminalWorkersCache = {
      workers: loadAllWorkers().filter(w => w.status === 'done' || w.status === 'error'),
      expiresAt: now + TERMINAL_CACHE_TTL_MS,
    };
  }
  return terminalWorkersCache.workers;
}

/** Test-only: drop the cache and its scan counter so the next call re-scans. */
export function __resetDiskWorkersCache(): void {
  terminalWorkersCache = null;
  diskScanCountForTests = 0;
}

/** Test-only: how many real disk scans loadTerminalWorkersCached has performed. */
export function __getDiskScanCountForTests(): number {
  return diskScanCountForTests;
}

/** Delete a worker's persisted state */
export function deleteWorker(workerId: string): void {
  const filePath = workerPath(workerId);
  try {
    unlinkSync(filePath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`[WorkerStore] Failed to delete worker ${workerId}:`, err);
    }
  }
}
