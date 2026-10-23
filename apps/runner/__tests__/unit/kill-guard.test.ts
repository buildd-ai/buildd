/**
 * An agent's kill by process name must not reach the runner (kill-guard.ts).
 *
 * 2026-10-23: an agent on a Windows runner ran `Get-Process bun,git |
 * Stop-Process -Force` to stop its own stuck background sweep. The runner is a
 * bun process, so the call killed it mid-session and stranded the worker.
 */
import { describe, test, expect } from 'bun:test';
import { findRunnerKill, runnerProcessIds } from '../../src/kill-guard';
import { HookFactory } from '../../src/hook-factory';
import type { LocalWorker } from '../../src/types';

const RUNNER_PIDS = [4321, 1200];

describe('findRunnerKill', () => {
  for (const command of [
    'Get-Process bun,git | Stop-Process -Force',
    'Get-Process -Name bun | Stop-Process',
    'gps node | kill',
    'Stop-Process -Name bun -Force',
    'Stop-Process -Name "bun"',
    'Stop-Process -ProcessName git',
    'taskkill /IM bun.exe /F',
    'taskkill /F /T /IM node.exe',
    'pkill bun',
    'pkill -f bun',
    'killall node',
    "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Invoke-CimMethod -MethodName Terminate",
    "ps aux | grep bun | awk '{print $2}' | xargs kill -9",
    'Get-Process | Stop-Process -Force',
    'cd C:/x; Get-Process bun* | Stop-Process',
  ]) {
    test(`refuses: ${command}`, () => {
      expect(findRunnerKill(command, RUNNER_PIDS)).not.toBeNull();
    });
  }

  for (const command of [
    'Stop-Process -Id 4321 -Force',
    'taskkill /PID 1200 /F',
    'kill -9 4321',
  ]) {
    test(`refuses a kill of the runner's own pid: ${command}`, () => {
      expect(findRunnerKill(command, RUNNER_PIDS)?.reason).toContain('runner');
    });
  }

  for (const command of [
    'Stop-Process -Id 98765 -Force',
    'taskkill /PID 98765 /T /F',
    'bun run scripts/recon.ts & pid=$!; sleep 5; kill $pid',
    'kill 98765',
    'Get-Process bun | Select-Object Id,StartTime',
    'bun run test',
    'git status',
    'rm -rf node_modules/.cache',
    'echo skill',
  ]) {
    test(`allows: ${command}`, () => {
      expect(findRunnerKill(command, RUNNER_PIDS)).toBeNull();
    });
  }

  test("the runner's own pid is always protected", () => {
    expect(runnerProcessIds()).toContain(process.pid);
    expect(findRunnerKill(`Stop-Process -Id ${process.pid}`, runnerProcessIds())).not.toBeNull();
  });
});

describe('permission hook', () => {
  const worker = {
    id: 'w-1', taskId: 't-1', status: 'working', milestones: [], messages: [],
    checkpointEvents: new Set(),
  } as unknown as LocalWorker;
  const factory = new HookFactory({
    config: {},
    buildd: { updateWorker: async () => ({}) } as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
  } as any);
  const run = (tool_name: string, command: string) =>
    factory.createPermissionHook(worker)({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command } } as any, undefined, { signal: new AbortController().signal }) as Promise<any>;

  test('denies the PowerShell call from the incident', async () => {
    const out = await run('PowerShell', 'Get-Process bun,git | Stop-Process -Force');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('by name');
  });

  test('denies the same kill through Bash', async () => {
    const out = await run('Bash', 'taskkill /IM bun.exe /F');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('allows a kill by a pid the agent started', async () => {
    const out = await run('PowerShell', 'Stop-Process -Id 98765 -Force');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
