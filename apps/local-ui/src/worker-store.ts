import * as fs from 'fs';
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } = fs;
import { join } from 'path';
import { homedir } from 'os';
import type { LocalWorker, CheckpointEventType } from './types';

const WORKERS_DIR = join(homedir(), '.buildd', 'workers');

// Fields to persist (excludes transient UI state)
const PERSISTED_FIELDS = [
  'id', 'taskId', 'taskTitle', 'taskDescription', 'workspaceId', 'workspaceName',
  'branch', 'status', 'error', 'completedAt', 'lastActivity', 'sessionId',
  'waitingFor', 'planContent', 'planFilePath', 'planStartMessageIndex',
  'messages', 'milestones', 'toolCalls', 'commits',
  'output', 'teamState', 'worktreePath', 'promptSuggestions', 'lastAssistantMessage',
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

function ensureDir() {
  if (!existsSync(WORKERS_DIR)) {
    mkdirSync(WORKERS_DIR, { recursive: true });
  }
}

function workerPath(workerId: string): string {
  return join(WORKERS_DIR, `${workerId}.json`);
}

function tmpPath(workerId: string): string {
  return join(WORKERS_DIR, `${workerId}.json.tmp`);
}

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
}

/** Load all persisted workers from disk */
export function loadAllWorkers(): LocalWorker[] {
  if (!existsSync(WORKERS_DIR)) return [];

  const workers: LocalWorker[] = [];
  const now = Date.now();
  let files: string[];

  try {
    files = readdirSync(WORKERS_DIR);
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = join(WORKERS_DIR, file);

    // Clean up orphaned .tmp files
    if (file.endsWith('.tmp')) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    if (!file.endsWith('.json')) continue;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as PersistedWorker;

      // Skip files older than 24h
      if (data._savedAt && now - data._savedAt > MAX_AGE_MS) {
        try { unlinkSync(filePath); } catch {}
        continue;
      }

      // Reconstruct LocalWorker with transient defaults
      const worker: LocalWorker = {
        id: data.id as string,
        taskId: data.taskId as string,
        taskTitle: data.taskTitle as string,
        taskDescription: data.taskDescription as string | undefined,
        workspaceId: data.workspaceId as string,
        workspaceName: data.workspaceName as string,
        branch: data.branch as string,
        status: data.status as LocalWorker['status'],
        error: data.error as string | undefined,
        completedAt: data.completedAt as number | undefined,
        lastActivity: data.lastActivity as number,
        sessionId: data.sessionId as string | undefined,
        waitingFor: data.waitingFor as LocalWorker['waitingFor'],
        planContent: data.planContent as string | undefined,
        planStartMessageIndex: data.planStartMessageIndex as number | undefined,
        planFilePath: data.planFilePath as string | undefined,
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
