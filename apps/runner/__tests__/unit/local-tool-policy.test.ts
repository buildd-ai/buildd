/**
 * Local tool calls are decided by policy, never by whoever is watching.
 *
 * The PreToolUse hook already allows or denies every tool call by fixed rule.
 * What used to reach a person was the remainder: the agent SDK's own safety
 * checks (PermissionRequest) and a background subagent's would-be prompt
 * (canUseTool). Those asked "Allow once / Always allow / Deny" in a channel no
 * spec defines, unrecorded and outside team policy, and "Always allow" rewrote
 * the session's settings. Now they are refused with a reason and a way on; a
 * run that genuinely needs more asks through AskUserQuestion, the one human
 * channel. BUILDD_PERMISSION_PROMPTS=ask keeps the old prompt while rolling out.
 */
import { describe, expect, mock, test } from 'bun:test';
import { HookFactory } from '../../src/hook-factory';
import { localPolicyDenial, permissionPromptMode } from '../../src/local-tool-policy';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';
import type { LocalWorker, Milestone } from '../../src/types';

function makeWorker(): LocalWorker {
  return {
    id: 'worker-1', taskId: 'task-1', taskTitle: 'T', workspaceId: 'ws-1', workspaceName: 'w', branch: 'main',
    status: 'working', hasNewActivity: false, startedAt: Date.now(), lastActivity: Date.now(), milestones: [],
    currentAction: '', commits: [], output: [], toolCalls: [], messages: [], subagentTasks: [], checkpoints: [],
    checkpointEvents: new Set(), phaseText: null, phaseStart: null, phaseToolCount: 0, phaseTools: [],
  } as LocalWorker;
}

function makeFactory(mode?: 'policy' | 'ask') {
  const pending = new Map<string, any>();
  const milestones: Milestone[] = [];
  const updateWorker = mock(async () => ({}));
  const factory = new HookFactory({
    config: mode ? { permissionPrompts: mode } : {},
    buildd: { updateWorker } as any,
    addMilestone: (_w, m) => { milestones.push(m); },
    emit: () => {},
    pendingPermissionRequests: pending,
  });
  return { factory, pending, milestones, updateWorker };
}

const OPTS = { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'req-1' };

describe('permissionPromptMode', () => {
  test('policy unless the operator keeps the old prompt', () => {
    expect(permissionPromptMode({})).toBe('policy');
    expect(permissionPromptMode({ BUILDD_PERMISSION_PROMPTS: 'ask' })).toBe('ask');
    expect(permissionPromptMode({ BUILDD_PERMISSION_PROMPTS: 'yes please' })).toBe('policy');
  });
});

describe('localPolicyDenial: the one rule set every path applies', () => {
  test('refuses what the PreToolUse hook refuses, in runner-denial wording', () => {
    for (const [tool, input] of [
      ['Bash', { command: 'rm -rf /' }],
      ['Bash', { command: 'cat ~/.claude/.credentials.json' }],
      ['Read', { file_path: '/home/me/.claude/.credentials.json' }],
      ['Write', { file_path: '/etc/hosts' }],
    ] as const) {
      const denial = localPolicyDenial(tool, input as Record<string, unknown>, []);
      expect(denial, `${tool} ${JSON.stringify(input)}`).toContain(RUNNER_DENIAL_MARKER);
    }
  });

  test('has nothing against an ordinary call', () => {
    expect(localPolicyDenial('Bash', { command: 'bun test' }, [])).toBeNull();
    expect(localPolicyDenial('Edit', { file_path: '/repo/src/a.ts' }, [])).toBeNull();
    expect(localPolicyDenial('Read', { file_path: '/repo/src/a.ts' }, [])).toBeNull();
  });
});

describe('PermissionRequest (the SDK\'s own safety check)', () => {
  test('is refused by policy at once: nobody is asked, nothing waits, settings are not touched', async () => {
    const { factory, pending, milestones, updateWorker } = makeFactory();
    const worker = makeWorker();
    const hook = factory.createPermissionRequestHook(worker);
    const result: any = await hook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'cat /home/me/.claude/projects/x.jsonl' },
      permission_suggestions: [{ type: 'addDirectories', directories: ['/home/me/.claude'] }],
    } as any, undefined, { signal: new AbortController().signal } as any);

    const decision = result.hookSpecificOutput.decision;
    expect(result.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain(RUNNER_DENIAL_MARKER);
    expect(decision.message).toContain('AskUserQuestion');
    expect(decision.updatedPermissions).toBeUndefined();
    expect(worker.status).toBe('working');
    expect(worker.waitingFor).toBeUndefined();
    expect(pending.size).toBe(0);
    expect(updateWorker).not.toHaveBeenCalled();
    expect(milestones.map(m => (m as any).label)).toEqual(['Refused by policy: Bash']);
  });

  test('a call the rule set names gets that rule\'s reason, not the generic one', async () => {
    const { factory } = makeFactory();
    const result: any = await factory.createPermissionRequestHook(makeWorker())({
      hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/etc/hosts' },
    } as any, undefined, { signal: new AbortController().signal } as any);
    expect(result.hookSpecificOutput.decision.message).toContain('/etc/hosts');
  });

  test('AskUserQuestion is still allowed straight through', async () => {
    const { factory } = makeFactory();
    const result: any = await factory.createPermissionRequestHook(makeWorker())({
      hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?' }] },
    } as any, undefined, { signal: new AbortController().signal } as any);
    expect(result.hookSpecificOutput.decision.behavior).toBe('allow');
  });

  test('BUILDD_PERMISSION_PROMPTS=ask keeps the old prompt', async () => {
    const { factory, pending } = makeFactory('ask');
    const worker = makeWorker();
    void factory.createPermissionRequestHook(worker)({
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push' },
    } as any, undefined, { signal: new AbortController().signal } as any);
    expect(worker.waitingFor?.type).toBe('permission');
    expect(pending.has(worker.id)).toBe(true);
  });
});

describe('canUseTool for a background subagent', () => {
  test('is refused by policy at once, as subagent prompts were before SDK 0.3.186', async () => {
    const { factory, pending, milestones } = makeFactory();
    const worker = makeWorker();
    const result: any = await factory.createCanUseToolCallback(worker, false)('Bash', { command: 'npm test' }, { ...OPTS, agentID: 'sub-1' });
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain(RUNNER_DENIAL_MARKER);
    expect(worker.waitingFor).toBeUndefined();
    expect(pending.size).toBe(0);
    expect(milestones.map(m => (m as any).label)).toEqual(['Refused by policy: Bash (agent: sub-1)']);
  });

  test('the main agent is unchanged: its calls are decided by the PreToolUse hook', async () => {
    const { factory } = makeFactory();
    const result: any = await factory.createCanUseToolCallback(makeWorker(), false)('Bash', { command: 'ls' }, OPTS);
    expect(result.behavior).toBe('allow');
  });
});
