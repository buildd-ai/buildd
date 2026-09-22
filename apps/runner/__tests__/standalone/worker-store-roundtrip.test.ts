/**
 * Unit tests for worker-store.ts disk persistence round-trip.
 *
 * IMPORTANT: This test uses real filesystem I/O and must NOT share a process
 * with tests that mock 'fs'. Bun's mock.module is process-global, so other
 * test files' fs mocks would break worker-store. This file has no mocks.
 *
 * Run this file alone: bun run scripts/run-unit-tests.ts apps/runner/__tests__/standalone/worker-store-roundtrip.test.ts
 *
 * When run as part of the full suite, bun may parallelize test files into
 * the same process. If tests fail in suite but pass standalone, that's the
 * fs mock leak issue — the tests are still valid.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveWorker, loadWorker, loadAllWorkers, deleteWorker, __resetWorkerStoreRoot } from '../../src/worker-store';
import type { LocalWorker } from '../../src/types';

// NEVER the real home. This file calls the real saveWorker/loadWorker/
// loadAllWorkers -- no fs mock, no store mock -- so pointing it at
// $HOME/.buildd put fixture records into the operator's live runner store,
// where `loadAllWorkers` rewrote them to `error` status and the running runner
// logged a bogus "not found remotely" reconcile line for each (their task ids
// have no server row). BUILDD_HOME is injected per file by
// scripts/run-unit-tests.ts; the fallback keeps a bare `bun test <file>` safe.
process.env.BUILDD_HOME ??= mkdtempSync(join(tmpdir(), 'buildd-store-roundtrip-'));
__resetWorkerStoreRoot();

const TEST_HOME = process.env.BUILDD_HOME;
const WORKERS_DIR = join(TEST_HOME, 'workers');
const TEST_PREFIX = `_test_rt_${Date.now()}`;

// Track all worker IDs for cleanup
const createdIds: string[] = [];

function uniqueId(label = 'w'): string {
  const id = `${TEST_PREFIX}_${label}_${Math.random().toString(36).slice(2, 8)}`;
  createdIds.push(id);
  return id;
}

/** Build a full LocalWorker with all persisted + transient fields populated */
function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  const id = overrides.id ?? uniqueId();
  if (overrides.id && !createdIds.includes(overrides.id)) {
    createdIds.push(overrides.id);
  }
  return {
    id,
    taskId: 'task-123',
    taskTitle: 'Test task title',
    taskDescription: 'A description for the task',
    workspaceId: 'ws-456',
    workspaceName: 'Test Workspace',
    branch: 'feat/test-branch',
    status: 'working',
    error: 'some error message',
    completedAt: Date.now() - 1000,
    lastActivity: Date.now(),
    sessionId: 'session-abc-789',
    waitingFor: {
      type: 'question',
      prompt: 'What should I do?',
      options: [{ label: 'Option A', description: 'First option' }],
      toolUseId: 'tool-use-1',
    },
    messages: [
      { type: 'text', content: 'Hello', timestamp: 1000 },
      { type: 'tool_use', name: 'Read', input: { file: 'test.ts' }, timestamp: 2000 },
      { type: 'user', content: 'Continue', timestamp: 3000 },
    ],
    milestones: [
      { type: 'phase', label: 'Reading files', toolCount: 5, ts: 1000 },
      { type: 'status', label: 'Progress update', progress: 50, ts: 2000 },
      { type: 'checkpoint', event: 'first_read', label: 'First file read', ts: 3000 },
      { type: 'action', label: 'Editing code', ts: 4000 },
    ],
    toolCalls: [
      { name: 'Read', timestamp: 1000, input: { file: 'test.ts' } },
      { name: 'Edit', timestamp: 2000, input: { file: 'test.ts', content: 'new' } },
    ],
    commits: [
      { sha: 'abc123', message: 'feat: initial commit' },
      { sha: 'def456', message: 'fix: typo' },
    ],
    output: ['Line 1', 'Line 2', 'Line 3'],
    teamState: {
      teamName: 'test-team',
      members: [
        { name: 'lead', role: 'leader', status: 'active', spawnedAt: 1000 },
        { name: 'worker-1', status: 'idle', spawnedAt: 2000 },
      ],
      messages: [
        { from: 'lead', to: 'worker-1', content: 'Do task', summary: 'Assignment', timestamp: 3000 },
      ],
      createdAt: 1000,
    },
    worktreePath: '/tmp/worktrees/test',
    promptSuggestions: ['Run tests', 'Deploy'],
    lastAssistantMessage: 'I have completed the task.',
    // Transient fields
    hasNewActivity: true,
    currentAction: 'Reading files...',
    subagentTasks: [
      {
        taskId: 'sub-1', toolUseId: 'tu-1', description: 'Research', taskType: 'explore',
        startedAt: 1000, status: 'running',
      },
    ],
    checkpoints: [
      { uuid: 'cp-1', timestamp: 1000, files: [{ filename: 'test.ts', file_id: 'f-1' }] },
    ],
    checkpointEvents: new Set(['first_read', 'session_started']),
    phaseText: 'Analyzing code',
    phaseStart: Date.now(),
    phaseToolCount: 3,
    phaseTools: ['Read', 'Grep'],
    ...overrides,
  };
}

afterAll(() => {
  // Still id-by-id (a crash mid-file must not strand anything), but no longer
  // the only thing standing between this suite and real data.
  for (const id of createdIds) {
    try { deleteWorker(id); } catch {}
    const p = join(WORKERS_DIR, `${id}.json`);
    try { unlinkSync(p); } catch {}
  }
  // Only ever a directory this file created under tmpdir().
  if (TEST_HOME.startsWith(tmpdir())) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

describe('worker-store round-trip', () => {
  test('saveWorker → loadWorker preserves all PERSISTED_FIELDS', () => {
    const worker = makeWorker();
    saveWorker(worker);

    const loaded = loadWorker(worker.id);
    expect(loaded).not.toBeNull();

    expect(loaded!.id).toBe(worker.id);
    expect(loaded!.taskId).toBe(worker.taskId);
    expect(loaded!.taskTitle).toBe(worker.taskTitle);
    expect(loaded!.taskDescription).toBe(worker.taskDescription);
    expect(loaded!.workspaceId).toBe(worker.workspaceId);
    expect(loaded!.workspaceName).toBe(worker.workspaceName);
    expect(loaded!.branch).toBe(worker.branch);
    expect(loaded!.status).toBe(worker.status);
    expect(loaded!.error).toBe(worker.error);
    expect(loaded!.completedAt).toBe(worker.completedAt);
    expect(loaded!.lastActivity).toBe(worker.lastActivity);
    expect(loaded!.sessionId).toBe(worker.sessionId);
    expect(loaded!.waitingFor).toEqual(worker.waitingFor);
    expect(loaded!.messages).toEqual(worker.messages);
    expect(loaded!.milestones).toEqual(worker.milestones);
    expect(loaded!.toolCalls).toEqual(worker.toolCalls);
    expect(loaded!.commits).toEqual(worker.commits);
    expect(loaded!.output).toEqual(worker.output);
    expect(loaded!.teamState).toEqual(worker.teamState);
    expect(loaded!.worktreePath).toBe(worker.worktreePath);
    expect(loaded!.promptSuggestions).toEqual(worker.promptSuggestions);
    expect(loaded!.lastAssistantMessage).toBe(worker.lastAssistantMessage);
  });

  test('sessionId survives round-trip (critical for resume)', () => {
    const worker = makeWorker({ sessionId: 'resume-session-xyz' });
    saveWorker(worker);

    const loaded = loadWorker(worker.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('resume-session-xyz');
  });

  test('transient fields get default values after reload', () => {
    const worker = makeWorker({
      hasNewActivity: true,
      currentAction: 'Doing stuff',
      subagentTasks: [{ taskId: 't', toolUseId: 'tu', description: 'd', taskType: 'explore', startedAt: 0, status: 'running' }],
      checkpoints: [{ uuid: 'u', timestamp: 0, files: [] }],
      checkpointEvents: new Set(['first_read', 'first_edit']),
      phaseText: 'phase',
      phaseStart: 999,
      phaseToolCount: 7,
      phaseTools: ['Read'],
    });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.hasNewActivity).toBe(false);
    expect(loaded.currentAction).toBe('');
    expect(loaded.subagentTasks).toEqual([]);
    expect(loaded.checkpoints).toEqual([]);
    expect(loaded.phaseText).toBeNull();
    expect(loaded.phaseStart).toBeNull();
    expect(loaded.phaseToolCount).toBe(0);
    expect(loaded.phaseTools).toEqual([]);
  });

  test('checkpointEvents set is rebuilt from checkpoint milestones', () => {
    const worker = makeWorker({
      milestones: [
        { type: 'checkpoint', event: 'first_read', label: 'First file read', ts: 1000 },
        { type: 'checkpoint', event: 'first_commit', label: 'First commit', ts: 2000 },
        { type: 'phase', label: 'Some phase', toolCount: 2, ts: 500 },
      ],
    });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.checkpointEvents).toBeInstanceOf(Set);
    expect(loaded.checkpointEvents.has('first_read')).toBe(true);
    expect(loaded.checkpointEvents.has('first_commit')).toBe(true);
    expect(loaded.checkpointEvents.has('session_started')).toBe(false);
    expect(loaded.checkpointEvents.size).toBe(2);
  });

  test('messages array truncated to MAX_MESSAGES (200)', () => {
    const messages = Array.from({ length: 300 }, (_, i) => ({
      type: 'text' as const,
      content: `Message ${i}`,
      timestamp: i,
    }));
    const worker = makeWorker({ messages });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.messages).toHaveLength(200);
    expect((loaded.messages[0] as any).content).toBe('Message 100');
    expect((loaded.messages[199] as any).content).toBe('Message 299');
  });

  test('toolCalls truncated to MAX_TOOL_CALLS (200)', () => {
    const toolCalls = Array.from({ length: 250 }, (_, i) => ({
      name: `Tool_${i}`,
      timestamp: i,
      input: { idx: i },
    }));
    const worker = makeWorker({ toolCalls });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.toolCalls).toHaveLength(200);
    expect(loaded.toolCalls[0].name).toBe('Tool_50');
  });

  test('toolCall input truncated when exceeding MAX_TOOL_INPUT_LENGTH (500)', () => {
    const bigInput = { data: 'x'.repeat(1000) };
    const worker = makeWorker({
      toolCalls: [{ name: 'BigTool', timestamp: 1000, input: bigInput }],
    });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.toolCalls).toHaveLength(1);
    expect(loaded.toolCalls[0].input._truncated).toBeDefined();
    expect(loaded.toolCalls[0].input._truncated.length).toBe(500);
  });

  test('output truncated to MAX_OUTPUT (100)', () => {
    const output = Array.from({ length: 150 }, (_, i) => `Line ${i}`);
    const worker = makeWorker({ output });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.output).toHaveLength(100);
    expect(loaded.output[0]).toBe('Line 50');
    expect(loaded.output[99]).toBe('Line 149');
  });

  test('milestones truncated to MAX_MILESTONES (30)', () => {
    const milestones = Array.from({ length: 40 }, (_, i) => ({
      type: 'phase' as const,
      label: `Phase ${i}`,
      toolCount: i,
      ts: i * 1000,
    }));
    const worker = makeWorker({ milestones });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.milestones).toHaveLength(30);
  });

  test('commits truncated to MAX_COMMITS (50)', () => {
    const commits = Array.from({ length: 60 }, (_, i) => ({
      sha: `sha-${i}`,
      message: `Commit ${i}`,
    }));
    const worker = makeWorker({ commits });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded.commits).toHaveLength(50);
  });

  test('expired workers (>24h of inactivity) return null and the file is deleted', () => {
    // Rewritten, not appended to: this used to age only `_savedAt`, which is the
    // WRITE time and is re-stamped by every persist, so it asserted a TTL that
    // could never be reached in practice. Age the activity fields too --
    // worker-store.activityAt is what expiry keys on now. The inverted cases
    // (fresh write + stale activity, and vice versa) live in
    // apps/runner/__tests__/unit/worker-store-integrity.test.ts.
    const worker = makeWorker();
    saveWorker(worker);

    const filePath = join(WORKERS_DIR, `${worker.id}.json`);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const stale = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    data._savedAt = stale;
    data.lastActivity = stale;
    data.completedAt = stale;
    writeFileSync(filePath, JSON.stringify(data));

    const loaded = loadWorker(worker.id);
    expect(loaded).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  test('corrupted JSON files return null from loadWorker', () => {
    const workerId = uniqueId('corrupt');
    mkdirSync(WORKERS_DIR, { recursive: true });
    const filePath = join(WORKERS_DIR, `${workerId}.json`);
    writeFileSync(filePath, '{invalid json!!!');

    const loaded = loadWorker(workerId);
    expect(loaded).toBeNull();
  });

  test('corrupted JSON files are deleted by loadAllWorkers', () => {
    const workerId = uniqueId('corrupt-all');
    mkdirSync(WORKERS_DIR, { recursive: true });
    const filePath = join(WORKERS_DIR, `${workerId}.json`);
    writeFileSync(filePath, 'not-json');

    loadAllWorkers();
    expect(existsSync(filePath)).toBe(false);
  });

  test('atomic write does not leave orphaned .tmp files', () => {
    const worker = makeWorker();
    saveWorker(worker);

    const files = readdirSync(WORKERS_DIR);
    const tmpFiles = files.filter((f: string) => f.startsWith(worker.id) && f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  test('orphaned .tmp files are cleaned up by loadAllWorkers', () => {
    mkdirSync(WORKERS_DIR, { recursive: true });
    const tmpName = `${uniqueId('orphan')}.json.tmp`;
    const tmpFile = join(WORKERS_DIR, tmpName);
    writeFileSync(tmpFile, '{}');

    loadAllWorkers();
    expect(existsSync(tmpFile)).toBe(false);
  });

  test('deleteWorker removes file from disk', () => {
    const worker = makeWorker();
    saveWorker(worker);

    const filePath = join(WORKERS_DIR, `${worker.id}.json`);
    expect(existsSync(filePath)).toBe(true);

    deleteWorker(worker.id);
    expect(existsSync(filePath)).toBe(false);
  });

  test('deleteWorker on non-existent worker does not throw', () => {
    expect(() => deleteWorker('nonexistent-worker-id')).not.toThrow();
  });

  test('loadWorker on non-existent worker returns null', () => {
    expect(loadWorker('does-not-exist-xyz')).toBeNull();
  });

  test('undefined optional fields stay undefined after round-trip', () => {
    const worker = makeWorker({
      error: undefined,
      completedAt: undefined,
      sessionId: undefined,
      waitingFor: undefined,
      teamState: undefined,
      worktreePath: undefined,
      promptSuggestions: undefined,
      lastAssistantMessage: undefined,
      taskDescription: undefined,
    });
    saveWorker(worker);

    const loaded = loadWorker(worker.id)!;
    expect(loaded).not.toBeNull();
    expect(loaded.error).toBeUndefined();
    expect(loaded.completedAt).toBeUndefined();
    expect(loaded.sessionId).toBeUndefined();
    expect(loaded.waitingFor).toBeUndefined();
    expect(loaded.teamState).toBeUndefined();
    expect(loaded.worktreePath).toBeUndefined();
  });
});
