/**
 * `discoverModelCapabilities` (prompt-builder.ts) — validates a task's
 * configured effort/thinking against what the SDK's `supportedModels()`
 * actually reports for the running model.
 *
 * Two independent bugs made this signal never fire in production:
 *
 * 1. `ModelInfo.value` is the model ALIAS (e.g. 'sonnet'); the wire id the
 *    fleet actually runs (e.g. 'claude-sonnet-5') lives in `resolvedModel`.
 *    The lookup compared `modelId` only against `m.value`, so a session
 *    running on an exact wire id — the normal case per this repo's own
 *    `register_skill` guidance to prefer exact model IDs — never matched
 *    any row. Every lookup in the fleet missed, for every model, and the
 *    capability-mismatch warnings this function exists to emit were
 *    unreachable code.
 * 2. The one branch that DOES fire when the lookup misses (`!currentModel`)
 *    was also the only warning branch that skipped `sessionLog` — console-only,
 *    so the one warning able to fire left no durable record.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/model-capability-discovery.test.ts
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const logged: Array<{ workerId: string; level: string; event: string; detail?: string; taskId?: string }> = [];

mock.module('../../src/session-logger', () => ({
  sessionLog: (workerId: string, level: string, event: string, detail?: string, taskId?: string) => {
    logged.push({ workerId, level, event, detail, taskId });
  },
}));

const { discoverModelCapabilities } = await import('../../src/prompt-builder');

function fakeWorker(): any {
  return { id: 'worker-1', taskId: 'task-1' };
}

function fakeQuery(models: any[]): any {
  return { supportedModels: () => Promise.resolve(models) };
}

async function run(models: any[], modelId: string, configured: any = {}) {
  const emitted: any[] = [];
  const worker = fakeWorker();
  discoverModelCapabilities(fakeQuery(models), worker, configured, modelId, (e: any) => emitted.push(e));
  // discoverModelCapabilities is fire-and-forget (queryInstance.supportedModels().then(...))
  await new Promise(resolve => setImmediate(resolve));
  return { worker, emitted };
}

beforeEach(() => {
  logged.length = 0;
});

describe('discoverModelCapabilities — alias vs wire id', () => {
  // The shape the SDK's own doc comment describes: an alias row whose `value`
  // is the short alias and whose `resolvedModel` is the wire id fleets
  // actually configure tasks with.
  const ALIAS_ROW = {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
    supportsAdaptiveThinking: true,
  };

  // @signal-fire: model-capability-validation
  test('matches a session running on the wire id against the alias row via resolvedModel', async () => {
    const { worker } = await run([ALIAS_ROW], 'claude-sonnet-5', { effort: 'xhigh' });
    // A real match must reach real capability validation, not the "not found" fallback.
    expect(worker.modelCapabilities.warnings).toEqual([
      'Effort "xhigh" not in supported levels [low, medium, high] for model "claude-sonnet-5"',
    ]);
    expect(worker.modelCapabilities.capabilities.supportsEffort).toBe(true);
  });

  test('still matches a session running on the bare alias, via value', async () => {
    const { worker } = await run([ALIAS_ROW], 'sonnet', { effort: 'xhigh' });
    expect(worker.modelCapabilities.capabilities.supportsEffort).toBe(true);
    expect(worker.modelCapabilities.warnings.length).toBeGreaterThan(0);
  });

  test('genuinely unknown model still reports not-found, and now logs it durably', async () => {
    const { worker } = await run([ALIAS_ROW], 'claude-nonexistent-9', {});
    expect(worker.modelCapabilities.warnings).toEqual([
      'Model "claude-nonexistent-9" not found in supported models list',
    ]);
    // Bug 2: this branch used to be console-only.
    expect(logged.some(l => l.event === 'model_capability' && l.workerId === 'worker-1' && l.taskId === 'task-1')).toBe(true);
  });

  test('a supported effort configuration on a correctly-matched model produces no warnings', async () => {
    const { worker } = await run([ALIAS_ROW], 'claude-sonnet-5', { effort: 'high' });
    expect(worker.modelCapabilities.warnings).toEqual([]);
  });

  test('every capability warning is durably logged via sessionLog, not console-only', async () => {
    await run([ALIAS_ROW], 'claude-sonnet-5', { effort: 'xhigh' });
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe('warn');
    expect(logged[0].event).toBe('model_capability');
  });
});
