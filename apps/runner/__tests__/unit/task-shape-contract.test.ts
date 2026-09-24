/**
 * Task-shape contract: every distinct way a task can END is run through the
 * REAL WorkerManager.startSession completion lifecycle, and the terminal
 * PATCH the runner sends is asserted.
 *
 * Why this exists: a change to the post-loop completion path was tested only
 * on sessions that end via complete_task. Reviewer tasks end differently —
 * outputSchema → the SDK's StructuredOutput tool → a `structured_output`
 * result, never complete_task — so the change started a closing turn for
 * every reviewer and threw away the verdict it had already produced. Nothing
 * ran that shape through the real lifecycle.
 *
 * THE TABLE BELOW IS THE ONE PLACE A NEW SHAPE IS ADDED. The coverage guard
 * at the bottom reads the shape vocabularies from their sources of truth
 * (@buildd/shared's OutputRequirement / TaskMode / AgentBackend /
 * LoopExitCondition, and the Claude Agent SDK's own result subtypes) and fails
 * if any value has no row — so a new output requirement, mode, backend, loop
 * exit condition or SDK ending cannot ship without a contract row.
 *
 * Harness: the backend is faked at the `createBackend` seam, exactly as in
 * closing-turn.test.ts; the fake replays a scripted SDK message stream through
 * the runner's own onProgress/handleMessage and yields the BackendEvents the
 * real backends yield (see __tests__/fixtures/task-shape-stream.ts). The
 * buildd client is faked with a tiny first-writer-wins server model: the
 * agent's complete_task terminalises the row, and a later runner status PATCH
 * is refused with `abort: true` — the real route's behaviour.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/task-shape-contract.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { LocalUIConfig } from '../../src/types';
import {
  type Script,
  init, say, success, errorResult, completeTask, createPr, createArtifact,
  structuredOutputTool, translateScriptedMessage, isCompleteTaskCall, scriptEnding,
} from '../fixtures/task-shape-stream';

// Read before `fs` is mocked below.
const SHARED_TYPES_SRC = readFileSync(join(import.meta.dir, '../../../../packages/shared/src/types.ts'), 'utf8');
const SDK_TYPES_SRC = readFileSync(
  join(dirname(Bun.resolveSync('@anthropic-ai/claude-agent-sdk', join(import.meta.dir, '../..'))), 'sdk.d.ts'),
  'utf8',
);

// ─── Fake server (first writer wins) ─────────────────────────────────────────

type Patch = { id: string; payload: any; accepted: boolean };
const patches: Patch[] = [];
/** Terminal status of the worker row server-side, and who wrote it. */
let server: { status: 'completed' | 'failed' | null; writer: 'agent' | 'runner' | null } = { status: null, writer: null };

function agentCompletedTask() {
  if (server.status === null) server = { status: 'completed', writer: 'agent' };
}

const mockUpdateWorker = mock(async (id: string, payload: any) => {
  const terminal = payload?.status === 'completed' || payload?.status === 'failed';
  if (terminal && server.status !== null) {
    patches.push({ id, payload, accepted: false });
    return { abort: true, actualStatus: server.status };
  }
  if (terminal) server = { status: payload.status, writer: 'runner' };
  patches.push({ id, payload, accepted: true });
  return payload?.metricsOnly ? { updated: Object.keys(payload) } : {};
});
const mockGetWorkerRemote = mock(async () => (server.status ? { status: server.status } : null));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

// ─── Fake backend ────────────────────────────────────────────────────────────

let scriptQueue: Script[] = [];
let backendCalls: Array<{ backend: string; config: any; opts?: any }> = [];

mock.module('../../src/backends/index.js', () => ({
  createBackend: (backend: string, config: any) => {
    const call: { backend: string; config: any; opts?: any } = { backend, config };
    backendCalls.push(call);
    const script = scriptQueue.shift() ?? [];
    return {
      async *runStreamed(opts: any) {
        call.opts = opts;
        for (const entry of script) {
          if ('__throw' in entry) throw new Error(entry.__throw as string);
          if ('__event' in entry) { yield entry.__event; continue; }
          await opts.onProgress?.(entry);
          if (isCompleteTaskCall(entry)) agentCompletedTask();
          const { events, stop } = translateScriptedMessage(entry);
          for (const e of events) yield e;
          if (stop) return;
        }
        yield { type: 'complete', summary: '' };
      },
    };
  },
  inferSandboxMode: () => 'workspace-write',
  ClaudeBackend: class {},
}));

mock.module('pusher-js', () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() { return { bind: () => {}, unbind_all: () => {}, unbind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: () => {},
  readSessionLogs: () => [],
  claimLog: () => {},
  cleanupOldLogs: () => {},
}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    requestSessionUploadUrl = async () => null;
    claimTask = mockClaimTask;
    getWorkspaceConfig = async () => ({ configStatus: 'unconfigured' });
    getCompactObservations = async () => ({ markdown: '', count: 0 });
    searchObservations = async () => [];
    getBatchObservations = async () => [];
    createObservation = async () => ({});
    listWorkspaces = async () => [];
    sendHeartbeat = async () => ({});
    runCleanup = async () => ({});
    searchFeedbackMemories = async () => [];
    getWorkerRemote = mockGetWorkerRemote;
    writeBackCodexAuth = async () => ({});
  },
}));

mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => '/tmp/test-workspace',
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => ['/tmp'],
  }),
}));

mock.module('fs', () => ({
  existsSync: () => false,
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
  copyFileSync: () => {},
  rmSync: () => {},
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadWorker: () => null,
  deleteWorker: () => {},
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
}));

mock.module('../../src/skills.js', () => ({ syncSkillToLocal: async () => {} }));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { OutputRequirement, TaskMode } = await import('../../../../packages/shared/src/types');
const { WorkerManager } = await import('../../src/workers');

// ─── The contract table ──────────────────────────────────────────────────────

type Terminal = {
  /** Server-side terminal status after the session. */
  status: 'completed' | 'failed';
  /** Who wrote it: the agent's own complete_task, or the runner's PATCH. */
  writer: 'agent' | 'runner';
  /** createBackend invocations. 1 = no closing turn / no extra session. */
  sessions: 1 | 2;
  /** Exact structuredOutput the runner must deliver (runner-written rows only). */
  structuredOutput?: Record<string, unknown>;
  summarySource?: 'fallback';
  /** resultMeta.closingTurnOutcome on whichever runner PATCH the server kept. */
  closingTurnOutcome?: string | RegExp;
  errorMatches?: RegExp;
  /** Extra payload assertions on the runner's terminal/metrics PATCH. */
  payload?: (p: any) => void;
};

type Shape = {
  name: string;
  task: Record<string, unknown>;
  /** One script per session: [original, closing turn?]. */
  scripts: Script[];
  expect: Terminal;
  /** Runs with OPENAI_API_KEY set so a Codex task gets past credential checks. */
  codex?: boolean;
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'request_changes'] }, summary: { type: 'string' } },
  required: ['verdict'],
};
const VERDICT = { verdict: 'request_changes', summary: 'Missing a regression test.' };
const PLAN = { plan: [{ title: 'Add endpoint', description: 'Wire the route.' }] };

const SHAPES: Shape[] = [
  // ── Structured-output shapes: the result IS the structured output ─────────
  {
    name: 'reviewer: outputSchema, ends via StructuredOutput, never calls complete_task',
    task: { roleSlug: 'reviewer', outputRequirement: 'none', outputSchema: REVIEW_SCHEMA },
    scripts: [[init(), say('Reviewed the diff.'), ...structuredOutputTool(VERDICT), success('sess-fixture', { structured_output: VERDICT })]],
    // The verdict IS the result. The summary is only the session's own text
    // tail, so it is honestly tagged fallback — never presented as authored.
    expect: { status: 'completed', writer: 'runner', sessions: 1, structuredOutput: VERDICT, summarySource: 'fallback' },
  },
  {
    name: 'reviewer on codex: structured output arrives on the BackendEvent, not onProgress',
    codex: true,
    task: { roleSlug: 'reviewer', backend: 'codex', outputRequirement: 'none', outputSchema: REVIEW_SCHEMA },
    scripts: [[init('thread-fixture'), say('Reviewed the diff.'), { __event: { type: 'turn_complete', structuredOutput: VERDICT } }]],
    expect: { status: 'completed', writer: 'runner', sessions: 1, structuredOutput: VERDICT, summarySource: 'fallback' },
  },
  {
    name: 'planning mode: plan returns as structured output under the planning schema',
    task: { mode: 'planning', outputRequirement: 'none' },
    scripts: [[init(), say('Here is the plan.'), ...structuredOutputTool(PLAN), success('sess-fixture', { structured_output: PLAN })]],
    expect: {
      status: 'completed', writer: 'runner', sessions: 1, structuredOutput: PLAN, summarySource: 'fallback',
    },
  },
  {
    name: 'loop structured_predicate: the predicate reads the structured output the runner sends',
    task: {
      outputRequirement: 'none', outputSchema: REVIEW_SCHEMA, loopIteration: 1,
      loopConfig: { exitCondition: { type: 'structured_predicate', predicate: { path: '/verdict', operator: 'eq', value: 'approve' } } },
    },
    scripts: [[init(), ...structuredOutputTool(VERDICT), success('sess-fixture', { structured_output: VERDICT })]],
    expect: { status: 'completed', writer: 'runner', sessions: 1, structuredOutput: VERDICT },
  },

  // ── Agent-authored completion: complete_task wins, runner sends metrics ───
  {
    name: 'builder pr_required: create_pr then complete_task',
    task: { roleSlug: 'builder', outputRequirement: 'pr_required' },
    scripts: [[init(), say('Implemented the fix.'), ...createPr(), ...completeTask('Opened the PR.'), success()]],
    expect: { status: 'completed', writer: 'agent', sessions: 1 },
  },
  {
    name: 'artifact_required: create_artifact then complete_task',
    task: { roleSlug: 'researcher', outputRequirement: 'artifact_required' },
    scripts: [[init(), ...createArtifact(), ...completeTask('Wrote the findings.'), success()]],
    expect: { status: 'completed', writer: 'agent', sessions: 1 },
  },
  {
    name: 'outputRequirement none: complete_task with no deliverable',
    task: { outputRequirement: 'none' },
    scripts: [[init(), say('Checked it; nothing to change.'), ...completeTask('No change needed.'), success()]],
    expect: { status: 'completed', writer: 'agent', sessions: 1 },
  },
  {
    name: 'loop pr_merged: builder opens the PR and completes; the server waits for the merge',
    task: { outputRequirement: 'pr_required', loopIteration: 0, loopConfig: { exitCondition: { type: 'pr_merged' } } },
    scripts: [[init(), ...createPr(), ...completeTask('Opened the PR.'), success()]],
    expect: { status: 'completed', writer: 'agent', sessions: 1 },
  },
  {
    name: 'loop pr_checks_green: builder opens the PR and completes; the server reads CI',
    task: { outputRequirement: 'pr_required', loopIteration: 0, loopConfig: { exitCondition: { type: 'pr_checks_green' } } },
    scripts: [[init(), ...createPr(), ...completeTask('Opened the PR.'), success()]],
    expect: { status: 'completed', writer: 'agent', sessions: 1 },
  },

  // ── Natural end without complete_task: the closing-turn path ──────────────
  {
    name: 'builder natural end (auto): closing turn authors complete_task',
    task: { roleSlug: 'builder', outputRequirement: 'auto' },
    scripts: [
      [init(), say('Pushed the branch.'), success()],
      [...completeTask('Pushed the branch.'), success()],
    ],
    expect: { status: 'completed', writer: 'agent', sessions: 2, closingTurnOutcome: 'authored' },
  },
  {
    name: 'builder natural end (auto): closing turn declines, runner falls back',
    task: { roleSlug: 'builder', outputRequirement: 'auto' },
    scripts: [
      [init(), say('Pushed the branch.'), success()],
      [say('Nothing more to add.'), success()],
    ],
    expect: {
      status: 'completed', writer: 'runner', sessions: 2, summarySource: 'fallback', closingTurnOutcome: 'declined',
      payload: p => expect(p.summary).toContain('Pushed the branch.'),
    },
  },
  {
    name: 'loop command: verification evidence rides the runner completion',
    task: { outputRequirement: 'auto', loopIteration: 2, loopConfig: { exitCondition: { type: 'command', command: 'bun run check' } } },
    scripts: [
      [init(), say('Iteration done.'), success()],
      [say('Nothing more to add.'), success()],
    ],
    expect: {
      status: 'completed', writer: 'runner', sessions: 2, summarySource: 'fallback',
      payload: p => expect(p.verificationEvidence).toMatchObject({ iteration: 2, conditionType: 'command', command: 'bun run check' }),
    },
  },

  // ── Failure shapes ────────────────────────────────────────────────────────
  {
    name: 'pr_required with no PR and no commits fails with the agent report, no closing turn',
    task: { outputRequirement: 'pr_required' },
    scripts: [[init(), say('Could not run the shell in this sandbox.'), success()]],
    expect: {
      status: 'failed', writer: 'runner', sessions: 1, closingTurnOutcome: 'skipped:no_deliverable',
      errorMatches: /Could not run the shell/,
    },
  },
  {
    name: 'max turns: exactly one closing turn past the cap, which authors complete_task',
    task: { outputRequirement: 'auto' },
    scripts: [
      [init(), say('Still working.'), errorResult('error_max_turns', 'Reached max turns')],
      [...completeTask('Partial progress.'), success()],
    ],
    expect: { status: 'completed', writer: 'agent', sessions: 2, closingTurnOutcome: 'authored' },
  },
  {
    name: 'SDK error result fails the task without a closing turn',
    task: { outputRequirement: 'auto' },
    scripts: [[init(), errorResult('error_during_execution', 'tool process crashed')]],
    expect: { status: 'failed', writer: 'runner', sessions: 1, closingTurnOutcome: 'skipped:error', errorMatches: /tool process crashed/ },
  },
  {
    name: 'structured output retries exhausted fails the task without a closing turn',
    task: { roleSlug: 'reviewer', outputRequirement: 'none', outputSchema: REVIEW_SCHEMA },
    scripts: [[init(), errorResult('error_max_structured_output_retries', 'output did not match schema')]],
    expect: { status: 'failed', writer: 'runner', sessions: 1, errorMatches: /did not match schema/ },
  },
  {
    name: 'session dollar cap fails as sessionBudgetCapped, never a usage wall',
    task: { outputRequirement: 'auto' },
    scripts: [[init(), errorResult('error_max_budget_usd', 'Reached maximum budget')]],
    expect: {
      status: 'failed', writer: 'runner', sessions: 1, closingTurnOutcome: 'skipped:session_budget_capped',
      payload: p => { expect(p.sessionBudgetCapped).toBe(true); expect(p.budgetExhausted).toBeUndefined(); },
    },
  },
  {
    name: 'aborted session fails as aborted, no closing turn',
    task: { outputRequirement: 'auto' },
    scripts: [[init(), { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-fixture', result: 'Aborted by user' }]],
    expect: { status: 'failed', writer: 'runner', sessions: 1, closingTurnOutcome: 'skipped:aborted' },
  },
  {
    name: 'backend throws mid-stream (crashed CLI) fails the task, no closing turn',
    task: { outputRequirement: 'auto' },
    scripts: [[init(), say('Starting.'), { __throw: 'Claude Code process exited with code 1' }]],
    expect: { status: 'failed', writer: 'runner', sessions: 1, closingTurnOutcome: 'skipped:error', errorMatches: /exited with code 1/ },
  },
];

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as LocalUIConfig;
}

function reset() {
  patches.length = 0;
  server = { status: null, writer: null };
  scriptQueue = [];
  backendCalls = [];
  mockUpdateWorker.mockClear();
  mockGetWorkerRemote.mockClear();
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
}

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) await new Promise(r => setTimeout(r, 10));
}

async function runShape(manager: InstanceType<typeof WorkerManager>, shape: Shape, workerId: string) {
  scriptQueue = shape.scripts.map(s => [...s]);
  const task = {
    id: `task-${workerId}`,
    title: shape.name,
    description: 'Synthetic task for the task-shape contract.',
    workspaceId: 'ws-fixture',
    workspace: { name: 'fixture-workspace' },
    status: 'waiting',
    priority: 1,
    ...shape.task,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/fixture', task }] }));
  const priorKey = process.env.OPENAI_API_KEY;
  if (shape.codex) process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    await manager.claimAndStart(task as any);
    // The session runs detached from claimAndStart; wait for the local worker
    // to reach a terminal state, then give trailing PATCHes a beat to land.
    await waitFor(() => ['done', 'error'].includes(manager.getWorker(workerId)?.status ?? ''));
    await new Promise(r => setTimeout(r, 50));
  } finally {
    if (shape.codex) {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }
  }
}

/** The runner PATCH whose content the server kept: its accepted terminal write, or the metrics-only re-send. */
function keptRunnerPatch(writer: 'agent' | 'runner') {
  if (writer === 'runner') return patches.find(p => p.accepted && (p.payload?.status === 'completed' || p.payload?.status === 'failed'));
  return patches.find(p => p.accepted && p.payload?.metricsOnly === true);
}

// ─── Contract ────────────────────────────────────────────────────────────────

describe('task-shape contract: terminal outcome through the real completion path', () => {
  let manager: InstanceType<typeof WorkerManager>;
  let seq = 0;

  beforeEach(reset);
  afterEach(() => { manager?.destroy(); });

  for (const shape of SHAPES) {
    test(shape.name, async () => {
      manager = new WorkerManager(makeConfig());
      await runShape(manager, shape, `w-shape-${++seq}`);
      const want = shape.expect;

      expect({ status: server.status, writer: server.writer }).toEqual({ status: want.status, writer: want.writer });
      expect(backendCalls.length).toBe(want.sessions);
      if (want.sessions === 2) {
        // A closing turn resumes the SAME session; it never starts a fresh one.
        const resumeId = shape.codex ? backendCalls[1].opts?.resumeThreadId : backendCalls[1].config.options?.resume;
        expect(resumeId).toBe(shape.codex ? 'thread-fixture' : 'sess-fixture');
      }

      // Exactly one terminal status write is ever accepted.
      const acceptedTerminal = patches.filter(p => p.accepted && (p.payload?.status === 'completed' || p.payload?.status === 'failed'));
      expect(acceptedTerminal.length).toBe(want.writer === 'runner' ? 1 : 0);

      const kept = keptRunnerPatch(want.writer);
      expect(kept, 'the runner must leave a PATCH the server kept').toBeDefined();
      const p = kept!.payload;

      if (want.writer === 'runner') {
        if ('structuredOutput' in want) expect(p.structuredOutput).toEqual(want.structuredOutput);
        else expect(p.structuredOutput).toBeUndefined();
        expect(p.summarySource).toBe(want.summarySource);
      }
      if (want.closingTurnOutcome !== undefined) {
        const got = p.resultMeta?.closingTurnOutcome;
        if (want.closingTurnOutcome instanceof RegExp) expect(got).toMatch(want.closingTurnOutcome);
        else expect(got).toBe(want.closingTurnOutcome);
      }
      if (want.errorMatches) expect(p.error).toMatch(want.errorMatches);
      want.payload?.(p);
    });
  }

  test('structured-output shapes wire the schema into the SDK request', async () => {
    for (const shape of SHAPES.filter(s => s.expect.structuredOutput && !s.codex)) {
      reset();
      manager = new WorkerManager(makeConfig());
      await runShape(manager, shape, `w-schema-${++seq}`);
      const schema = backendCalls[0].config.options?.outputFormat?.schema;
      expect(schema, shape.name).toBeDefined();
      if (shape.task.outputSchema) expect(schema).toEqual(shape.task.outputSchema);
      manager.destroy();
    }
  });
});

// ─── Coverage guard: a new shape cannot ship without a row ───────────────────

/** Quoted literals of a `export type X = 'a' | 'b';` union in shared types. */
function stringUnion(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export type ${name} =([^;]+);`));
  if (!m) throw new Error(`${name} not found in packages/shared/src/types.ts — update the task-shape guard`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function loopExitTypes(src: string): string[] {
  const start = src.indexOf('export type LoopExitCondition =');
  if (start < 0) throw new Error('LoopExitCondition not found in packages/shared/src/types.ts — update the task-shape guard');
  const body = src.slice(start, src.indexOf('\nexport ', start + 1));
  return [...new Set([...body.matchAll(/\btype: '([a-z_]+)'/g)].map(x => x[1]))];
}

/** Every result subtype the Claude Agent SDK can end a session with. */
function sdkResultSubtypes(src: string): string[] {
  const out: string[] = [];
  for (const name of ['SDKResultSuccess', 'SDKResultError']) {
    const m = src.match(new RegExp(`export declare type ${name} = \\{[^}]*?subtype: ([^;]+);`));
    if (!m) throw new Error(`${name} not found in the Claude Agent SDK types — update the task-shape guard`);
    out.push(...[...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  }
  return out;
}

describe('task-shape contract: every shape discriminator has a row', () => {
  const covered = {
    outputRequirement: new Set(SHAPES.map(s => (s.task.outputRequirement as string | undefined) ?? 'auto')),
    mode: new Set(SHAPES.map(s => (s.task.mode as string | undefined) ?? 'execution')),
    backend: new Set(SHAPES.map(s => (s.task.backend as string | undefined) ?? 'claude')),
    loopExit: new Set(SHAPES.map(s => (s.task.loopConfig as any)?.exitCondition?.type ?? 'none')),
    structuredOutput: new Set(SHAPES.map(s => (s.task.outputSchema || s.task.mode === 'planning') ? 'yes' : 'no')),
    ending: new Set(SHAPES.map(s => scriptEnding(s.scripts[0]))),
  };

  const required: Record<keyof typeof covered, string[]> = {
    outputRequirement: Object.values(OutputRequirement) as string[],
    mode: Object.values(TaskMode) as string[],
    backend: stringUnion(SHARED_TYPES_SRC, 'AgentBackend'),
    loopExit: ['none', ...loopExitTypes(SHARED_TYPES_SRC)],
    structuredOutput: ['yes', 'no'],
    // The SDK's own vocabulary, plus the two endings it has no subtype for.
    ending: [...sdkResultSubtypes(SDK_TYPES_SRC), 'aborted', 'thrown'],
  };

  for (const dim of Object.keys(required) as Array<keyof typeof covered>) {
    test(`${dim}: every value in the source of truth has a contract row`, () => {
      expect(required[dim].length).toBeGreaterThan(0);
      const missing = required[dim].filter(v => !covered[dim].has(v));
      expect(
        missing,
        `No task-shape contract row covers ${dim}=${missing.join(', ')}. Add a row to SHAPES in `
          + 'apps/runner/__tests__/unit/task-shape-contract.test.ts that runs that shape through the real completion path.',
      ).toEqual([]);
    });
  }

  test('the vocabularies are read from source, not hardcoded (sanity: known values present)', () => {
    expect(required.outputRequirement).toContain('pr_required');
    expect(required.mode).toContain('planning');
    expect(required.backend).toContain('codex');
    expect(required.loopExit).toContain('command');
    expect(required.ending).toContain('error_max_turns');
  });
});
