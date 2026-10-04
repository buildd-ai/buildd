/**
 * Every tool call the runner refuses must reach the agent with text that says
 * the RUNNER refused it, not a person, and that the task goes on.
 *
 * Why: a refusal with no reason, or with a bare one, is read as the user
 * declining, and Claude Code's own fallback text for a refused/cancelled call
 * is "The user doesn't want to take this action right now. STOP what you are
 * doing and wait for the user…". Autonomous workers that saw that stopped
 * "as you asked", never called complete_task, and were failed for shipping
 * nothing, although no human declined anything.
 *
 * Two layers:
 *  1. Behavioural: drive every deny path with an input that trips it and
 *     check the text the agent would see.
 *  2. Structural: scan the runner source so a NEW deny site that skips
 *     runnerDenial()/denyPreToolUse() fails here until it is covered.
 */

import { describe, test, expect, mock } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { HookFactory } from '../../src/hook-factory';
import { RUNNER_DENIAL_MARKER, runnerDenial, HUMAN_UI_DENIAL } from '../../src/runner-denial';
import type { LocalWorker } from '../../src/types';

const OWN = '/repo/.buildd-worktrees/own';
const PRIMARY = '/repo';

function makeFactory(opts: { inputAsRetry?: boolean; pending?: Map<string, any> } = {}) {
  return new HookFactory({
    config: { inputAsRetry: opts.inputAsRetry },
    buildd: { updateWorker: mock(async () => ({})) } as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: opts.pending ?? new Map(),
  });
}

const worker = { id: 'w-deny', taskId: 't-deny', commits: [], toolCalls: [] } as unknown as LocalWorker;
const signal = { signal: new AbortController().signal };
const pre = (tool_name: string, tool_input: Record<string, unknown>, cwd = OWN) =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd }) as any;

type Case = { name: string; run: () => Promise<string | undefined> };

const reasonOf = (r: any): string | undefined =>
  r?.hookSpecificOutput?.permissionDecision === 'deny' ? r.hookSpecificOutput.permissionDecisionReason : undefined;

/** One entry per deny site in hook-factory.ts. Keep in step with DENY_SITES below. */
const CASES: Case[] = [
  {
    name: 'read-jail: Read outside the worktree',
    run: async () => reasonOf(await makeFactory().createReadJailHook(worker, OWN, ['/secret'])(pre('Read', { file_path: '/secret/x' }), undefined, signal)),
  },
  {
    name: 'claude.ai artifact gate: delete',
    run: async () => reasonOf(await makeFactory().createClaudeAiArtifactHook(worker, 'publish')(pre('Artifact', { action: 'delete', url: 'u' }), undefined, signal)),
  },
  {
    name: 'worktree confinement: Bash cd into the primary clone',
    run: async () => reasonOf(await makeFactory().createWorktreeConfinementHook(worker, OWN, PRIMARY)(pre('Bash', { command: `cd ${PRIMARY} && ls` }), undefined, signal)),
  },
  {
    name: 'permission hook: AskUserQuestion that asks nothing',
    run: async () => reasonOf(await makeFactory().createPermissionHook(worker)(pre('AskUserQuestion', { questions: [] }), undefined, signal)),
  },
  {
    name: 'permission hook: AskUserQuestion in autonomous mode',
    run: async () => reasonOf(await makeFactory({ inputAsRetry: false }).createPermissionHook(worker)(
      pre('AskUserQuestion', { questions: [{ question: 'Which one?', options: [{ label: 'a' }, { label: 'b' }] }] }), undefined, signal)),
  },
  {
    name: 'permission hook: AskUserQuestion pushed back by the question gate',
    run: async () => {
      const gated = { ...worker, questionGate: { maxPushbacks: 2 } } as unknown as LocalWorker;
      const f = new HookFactory({
        config: {},
        buildd: { updateWorker: mock(async () => ({})), checkQuestion: async () => ({ verdict: 'pushback', outcome: 'pushback', reason: 'Not sent: add context. Then ask again.', version: 'v', latencyMs: 1 }) } as any,
        addMilestone: () => {},
        emit: () => {},
        pendingPermissionRequests: new Map(),
      });
      return reasonOf(await f.createPermissionHook(gated, { inputPolicy: 'allow' })(
        pre('AskUserQuestion', { questions: [{ question: 'Local or UTC?', options: [{ label: 'a' }, { label: 'b' }] }] }), undefined, signal));
    },
  },
  {
    name: 'permission hook: AskUserQuestion decided automatically by the question gate',
    run: async () => {
      const gated = { ...worker, questionGate: { maxPushbacks: 2 } } as unknown as LocalWorker;
      const f = new HookFactory({
        config: {},
        buildd: { updateWorker: mock(async () => ({})), checkQuestion: async () => ({ verdict: 'decide', outcome: 'decided', disposition: 'decide', reason: 'UTC. Decided automatically.', version: 'v', latencyMs: 1 }) } as any,
        addMilestone: () => {},
        emit: () => {},
        pendingPermissionRequests: new Map(),
      });
      return reasonOf(await f.createPermissionHook(gated, { inputPolicy: 'allow' })(
        pre('AskUserQuestion', { questions: [{ question: 'Local or UTC?', options: [{ label: 'a' }, { label: 'b' }] }] }), undefined, signal));
    },
  },
  {
    name: 'permission hook: dangerous Bash command',
    run: async () => reasonOf(await makeFactory().createPermissionHook(worker)(pre('Bash', { command: 'rm -rf /' }), undefined, signal)),
  },
  {
    name: 'permission hook: Bash read of a runner credential file',
    run: async () => reasonOf(await makeFactory().createPermissionHook(worker)(pre('Bash', { command: 'cat ~/.buildd/config.json' }), undefined, signal)),
  },
  {
    name: 'permission hook: Read of a runner credential file',
    run: async () => reasonOf(await makeFactory().createPermissionHook(worker)(pre('Read', { file_path: '/home/u/.buildd/config.json' }), undefined, signal)),
  },
  {
    name: 'permission hook: Write to a sensitive path',
    run: async () => reasonOf(await makeFactory().createPermissionHook(worker)(pre('Write', { file_path: '/etc/passwd' }), undefined, signal)),
  },
  {
    name: 'path-claim (enforce): edit path outside the worktree',
    run: async () => reasonOf(await makeFactory().createPathClaimHook(
      { ...worker, worktreePath: OWN, pathClaimMode: 'enforce' } as unknown as LocalWorker,
    )(pre('Write', { file_path: '/elsewhere/x.ts' }), undefined, signal)),
  },
  {
    name: 'path-claim (enforce): a confirmed live holder',
    run: async () => {
      const factory = new HookFactory({
        config: {},
        buildd: { claimPaths: mock(async () => ({ kind: 'conflict', blockingTaskId: 'bbbbbbbb-0000', blockingPath: 'a.ts', blocked: null })) } as any,
        addMilestone: () => {},
        emit: () => {},
        pendingPermissionRequests: new Map(),
      });
      return reasonOf(await factory.createPathClaimHook(
        { ...worker, worktreePath: OWN, pathClaimMode: 'enforce' } as unknown as LocalWorker,
      )(pre('Edit', { file_path: 'a.ts' }), undefined, signal));
    },
  },
  {
    name: 'path-claim (enforce): edit after a recorded collision',
    run: async () => reasonOf(await makeFactory().createPathClaimHook(
      { ...worker, pathClaimMode: 'enforce', pathCollision: { path: 'a.ts', blockingTaskId: 'bbbbbbbb-0000', source: 'sync', detectedAt: 1 } } as unknown as LocalWorker,
    )(pre('Edit', { file_path: 'b.ts' }), undefined, signal)),
  },
  {
    name: 'checkpoint guard (enforce): push with a collision',
    run: async () => reasonOf(await makeFactory().createPathCheckpointGuardHook(
      { ...worker, pathClaimMode: 'enforce' } as unknown as LocalWorker,
      async () => ({ path: 'a.ts', blockingTaskId: 'bbbbbbbb-0000', source: 'pre_push', detectedAt: 1 }),
    )(pre('Bash', { command: 'git push origin HEAD' }), undefined, signal)),
  },
  {
    name: 'canUseTool: second subagent request while one is pending',
    run: async () => {
      const pending = new Map<string, any>([[worker.id, { resolve: () => {}, toolInput: {}, suggestions: [] }]]);
      const r = await makeFactory({ pending }).createCanUseToolCallback(worker, false)(
        'Bash', { command: 'ls' }, { signal: new AbortController().signal, agentID: 'sub-1', requestId: 'r', toolUseID: 'u' });
      return r.behavior === 'deny' ? r.message : undefined;
    },
  },
];

/** Things the agent must be able to read off every runner denial. */
function expectRunnerAttributed(text: string | undefined) {
  expect(typeof text).toBe('string');
  expect(text!.trim().length).toBeGreaterThan(0);
  expect(text).toContain(RUNNER_DENIAL_MARKER);
  expect(text).toMatch(/nobody asked you to stop/i);
  expect(text).toMatch(/complete_task/);
  // The CLI's own user-rejection wording must never be what a runner denial says.
  expect(text).not.toMatch(/the user doesn't want/i);
}

describe('runner denials carry a runner-attributed, keep-going reason', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      expectRunnerAttributed(await c.run());
    });
  }

  test('the dangerous-command denial names the rule that matched', async () => {
    const text = await CASES.find(c => c.name.includes('dangerous Bash'))!.run();
    expect(text).toMatch(/rule \//);
  });

  test('runnerDenial includes the alternative when given', () => {
    expect(runnerDenial('x is blocked', 'do y')).toContain('Instead: do y.');
    expect(runnerDenial('x is blocked')).not.toContain('Instead:');
  });

  test('a human UI denial says a person refused one call, not the task', () => {
    expect(HUMAN_UI_DENIAL).toMatch(/person/);
    expect(HUMAN_UI_DENIAL).toMatch(/not an instruction to stop/i);
    expect(HUMAN_UI_DENIAL).toMatch(/complete_task/);
  });
});

// ─── Structural coverage ─────────────────────────────────────────────────────

const SRC = join(import.meta.dir, '../../src');

function runnerSources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...runnerSources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('every deny site in the runner source is covered', () => {
  const hookFactory = readFileSync(join(SRC, 'hook-factory.ts'), 'utf8');

  test('PreToolUse denials are built only by denyPreToolUse', () => {
    // The helper itself is the single literal `permissionDecision: 'deny'`.
    expect(hookFactory.match(/permissionDecision: 'deny'/g)?.length).toBe(1);
    for (const file of runnerSources()) {
      if (file.endsWith('hook-factory.ts')) continue;
      expect({ file, hit: /permissionDecision:\s*'deny'/.test(readFileSync(file, 'utf8')) }).toEqual({ file, hit: false });
    }
  });

  test('every denyPreToolUse call wraps a runnerDenial reason', () => {
    const calls = hookFactory.match(/denyPreToolUse\((?!reason: string)[^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('denyPreToolUse(runnerDenial(');
  });

  test('the behavioural table has one case per PreToolUse deny site, plus canUseTool', () => {
    const sites = (hookFactory.match(/denyPreToolUse\(runnerDenial\(/g) ?? []).length;
    // One worktree-confinement site covers Bash and every write tool.
    expect(CASES.length).toBe(sites + 1);
  });

  test('every behavior: deny result in the runner carries a non-empty message', () => {
    for (const file of runnerSources()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/behavior: 'deny'(?: as const)?,\s*\n?\s*message:\s*([^\n]+)/g)) {
        const expr = m[1].trim();
        expect({ file, expr, empty: /^(''|""|``)/.test(expr) }).toEqual({ file, expr, empty: false });
      }
      // A deny object with no message at all.
      for (const m of src.matchAll(/\{\s*behavior: 'deny'(?: as const)?\s*\}/g)) {
        expect({ file, deny: m[0] }).toBeUndefined();
      }
    }
  });
});
