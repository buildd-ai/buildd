/**
 * A retry that resumes a checkpoint which fails the repo's readiness command
 * must reach an agent turn to repair it; a fresh claim on an invalid tree must
 * still be blocked; and the readiness command must still pass before anything
 * ships from the resumed branch.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/resumed-readiness.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { runProvisionGate, type CommandRunner, type FsProbe, type ProvisionGateResult } from '../../src/env-verify';
import {
  createResumedReadinessGuard,
  deferrableReadinessFailure,
  readinessRepairSection,
  type DeferredReadiness,
} from '../../src/resumed-readiness';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';

const READINESS = 'bun run scripts/check-specs.ts --check';
const MANIFEST = [
  'toolchain:',
  '  runtime: bun',
  'install:',
  '  command: bun install --frozen-lockfile',
  'readiness:',
  `  command: ${READINESS}`,
].join('\n');

const fsWith = (manifest: string): FsProbe => ({
  exists: (p) => p === '.buildd/env.yaml',
  read: () => manifest,
});

/** Every command passes except the ones listed, which exit with the given outcome. */
function runner(overrides: Record<string, { code: number; stdout?: string; stderr?: string }>): CommandRunner {
  return (command) => {
    const o = overrides[command];
    return o ? { code: o.code, stdout: o.stdout ?? '', stderr: o.stderr ?? '' } : { code: 0, stdout: '', stderr: '' };
  };
}

const SPEC_ERROR = '✖ docs/specs/task-summary.md: code surface apps/web/src/app/api/tasks/[id]/summary/route.ts does not exist';

async function gateWith(overrides: Parameters<typeof runner>[0]): Promise<ProvisionGateResult> {
  return runProvisionGate({ root: '/wt', env: {}, fs: fsWith(MANIFEST), runCommand: runner(overrides) });
}

describe('deferrableReadinessFailure: fresh claim vs resumed checkpoint', () => {
  test('a fresh claim on a tree that fails readiness is still blocked', async () => {
    const gate = await gateWith({ [READINESS]: { code: 1, stderr: `${SPEC_ERROR}\n1 error(s)` } });
    expect(gate.ok).toBe(false);
    expect(gate.failure?.code).toBe('provision_readiness_failed');
    expect(deferrableReadinessFailure({ gate, resumed: null, canEnforceAtShip: true, root: '/wt', fs: fsWith(MANIFEST) })).toBeNull();
  });

  test('a resumed checkpoint that fails only readiness is handed to the session to repair, with the full output', async () => {
    const gate = await gateWith({ [READINESS]: { code: 1, stderr: `${SPEC_ERROR}\n1 error(s)` } });
    const d = deferrableReadinessFailure({ gate, resumed: { from: 'buildd/abc-task' }, canEnforceAtShip: true, root: '/wt', fs: fsWith(MANIFEST) });
    expect(d).not.toBeNull();
    expect(d!.step.command).toBe(READINESS);
    expect(d!.message).toContain('exit 1');
    expect(d!.output).toContain(SPEC_ERROR);
    expect(d!.output).toContain('1 error(s)');
    expect(d!.resumedFrom).toBe('buildd/abc-task');
  });

  test('a resumed checkpoint still blocks on a toolchain, install or env failure', async () => {
    const install = await gateWith({ 'bun install --frozen-lockfile': { code: 1, stderr: 'lockfile drift' } });
    expect(install.failure?.phase).toBe('install');
    expect(deferrableReadinessFailure({ gate: install, resumed: { from: 'b' }, canEnforceAtShip: true, root: '/wt', fs: fsWith(MANIFEST) })).toBeNull();

    const toolchain = await gateWith({ 'command -v bun': { code: 1 } });
    expect(toolchain.failure?.phase).toBe('toolchain');
    expect(deferrableReadinessFailure({ gate: toolchain, resumed: { from: 'b' }, canEnforceAtShip: true, root: '/wt', fs: fsWith(MANIFEST) })).toBeNull();

    const envManifest = `${MANIFEST}\nenv:\n  required: [SOME_SECRET]`;
    const env = await runProvisionGate({ root: '/wt', env: {}, fs: fsWith(envManifest), runCommand: runner({}) });
    expect(env.failure?.phase).toBe('env');
    expect(deferrableReadinessFailure({ gate: env, resumed: { from: 'b' }, canEnforceAtShip: true, root: '/wt', fs: fsWith(envManifest) })).toBeNull();
  });

  test('a resumed checkpoint on a backend with no ship seam keeps the blocking behaviour', async () => {
    const gate = await gateWith({ [READINESS]: { code: 1, stderr: SPEC_ERROR } });
    expect(deferrableReadinessFailure({ gate, resumed: { from: 'b' }, canEnforceAtShip: false, root: '/wt', fs: fsWith(MANIFEST) })).toBeNull();
  });

  test('nothing to defer when the gate passed or was not enforced', async () => {
    const ok = await gateWith({});
    expect(ok.ok).toBe(true);
    expect(deferrableReadinessFailure({ gate: ok, resumed: { from: 'b' }, canEnforceAtShip: true, root: '/wt', fs: fsWith(MANIFEST) })).toBeNull();
    const unenforced: ProvisionGateResult = { source: 'auto-detected', enforced: false, ok: true, steps: [] };
    expect(deferrableReadinessFailure({ gate: unenforced, resumed: { from: 'b' }, canEnforceAtShip: true, root: '/wt', fs: fsWith(MANIFEST) })).toBeNull();
  });
});

describe('readinessRepairSection', () => {
  test('names the branch, the command and its output, and says shipping is refused until it passes', () => {
    const d: DeferredReadiness = {
      step: { phase: 'readiness', label: READINESS, kind: 'command', command: READINESS, timeoutMs: 180_000 },
      message: `exit 1: ${SPEC_ERROR}`,
      output: `${SPEC_ERROR}\n1 error(s)`,
      resumedFrom: 'buildd/abc-task',
    };
    const text = readinessRepairSection(d);
    expect(text).toContain('buildd/abc-task');
    expect(text).toContain(`$ ${READINESS}`);
    expect(text).toContain(SPEC_ERROR);
    expect(text).toMatch(/refused until it does/);
  });
});

describe('createResumedReadinessGuard: final verification', () => {
  const deferred: DeferredReadiness = {
    step: { phase: 'readiness', label: READINESS, kind: 'command', command: READINESS, timeoutMs: 180_000 },
    message: 'exit 1: x',
    output: 'x',
    resumedFrom: 'buildd/abc-task',
  };
  const PUSH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } };
  const CREATE_PR = { hook_event_name: 'PreToolUse', tool_name: 'mcp__buildd__buildd_prs', tool_input: { action: 'create_pr', params: { title: 't' } } };
  const COMPLETE = { hook_event_name: 'PreToolUse', tool_name: 'mcp__buildd__buildd_work', tool_input: { action: 'complete_task', params: { summary: 's' } } };
  const COMPLETE_ERROR = { hook_event_name: 'PreToolUse', tool_name: 'mcp__buildd__buildd_work', tool_input: { action: 'complete_task', params: { error: 'not this branch' } } };
  const OTHER = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'bun run test' } };

  function harness(codes: number[], head: () => string | null = () => 'H1') {
    const ran: string[] = [];
    const milestones: string[] = [];
    let i = 0;
    const guard = createResumedReadinessGuard({
      deferred,
      cwd: '/wt',
      env: {},
      runCommand: (command) => {
        ran.push(command);
        const code = codes[Math.min(i++, codes.length - 1)];
        return { code, stdout: '', stderr: code === 0 ? '' : SPEC_ERROR };
      },
      headSha: head,
      milestone: (l) => milestones.push(l),
    });
    return { guard, ran, milestones };
  }
  const denied = (r: Record<string, any>) => r?.hookSpecificOutput?.permissionDecision === 'deny';

  test('push, create_pr and a successful complete_task are refused while readiness still fails', async () => {
    const { guard, ran } = harness([1]);
    for (const call of [PUSH, CREATE_PR, COMPLETE]) {
      const r = await guard(call);
      expect(denied(r)).toBe(true);
      expect(r.hookSpecificOutput.permissionDecisionReason).toContain(RUNNER_DENIAL_MARKER);
      expect(r.hookSpecificOutput.permissionDecisionReason).toContain(SPEC_ERROR);
    }
    expect(ran).toEqual([READINESS, READINESS, READINESS]);
  });

  test('a failure report and unrelated tools are never gated', async () => {
    const { guard, ran } = harness([1]);
    expect(await guard(COMPLETE_ERROR)).toEqual({});
    expect(await guard(OTHER)).toEqual({});
    expect(ran).toEqual([]);
  });

  test('once the repaired head passes, the ship goes through and that head is not re-checked', async () => {
    const { guard, ran, milestones } = harness([1, 0]);
    expect(denied(await guard(PUSH))).toBe(true);
    expect(await guard(PUSH)).toEqual({});
    expect(await guard(CREATE_PR)).toEqual({});
    expect(ran.length).toBe(2);
    expect(milestones).toContain('Readiness check passes on the repaired branch');
  });

  test('a new head after a pass is checked again', async () => {
    let head = 'H1';
    const { guard, ran } = harness([0, 1], () => head);
    expect(await guard(PUSH)).toEqual({});
    head = 'H2';
    expect(denied(await guard(COMPLETE))).toBe(true);
    expect(ran.length).toBe(2);
  });

  test('exit 2 (passed with a warning) counts as passing, as it does in the provision gate', async () => {
    const { guard } = harness([2]);
    expect(await guard(PUSH)).toEqual({});
  });
});
