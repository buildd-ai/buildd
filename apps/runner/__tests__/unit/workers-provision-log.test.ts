/**
 * Regression: two log lines the runner emits during `startSession`'s provision
 * gate block (apps/runner/src/workers.ts) dropped information that already
 * existed at the point of logging.
 *
 * 1. `env-verify.ts`'s `executeSteps` computes `StepResult.durationMs` for
 *    every phase (toolchain/install/env/provision/readiness), but the
 *    per-step `console.log` in workers.ts never read the field — ~2000 gate
 *    runs produced zero timing data despite the value existing.
 * 2. A role's `resolveRoleEnv` can report declared-but-unavailable secret
 *    labels (`missing`), but the caller only surfaced them via
 *    `console.warn` — nothing recorded on the worker, so a degraded session
 *    looked identical to a role with no requirements at all.
 *
 * These formatting expressions are extracted from WorkerManager.startSession()
 * for testing, mirroring the convention in workers-skills.test.ts (that inline
 * logic lives deep in one very large method that isn't independently testable
 * without extensive scaffolding).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/workers-provision-log.test.ts
 */
import { describe, test, expect } from 'bun:test';
import type { StepResult } from '../../src/env-verify';

// Extracted from WorkerManager.startSession()'s provision-gate step loop.
function formatProvisionLine(workerId: string, s: StepResult): string {
  const dur = s.durationMs != null ? ` (${s.durationMs}ms)` : '';
  return `[Worker ${workerId}] provision ${s.status} [${s.phase}] ${s.label} — ${s.message}${dur}`;
}

// Extracted from WorkerManager.startSession()'s role-env-resolution block.
function formatRoleEnvDegradedLabel(roleSlug: string, missing: string[]): string {
  return `Role env degraded: ${roleSlug} missing ${missing.join(', ')}`;
}

describe('provision gate log line', () => {
  test('carries durationMs when the step recorded one', () => {
    const step: StepResult = { phase: 'readiness', label: 'bun run scripts/check-specs.ts --check', status: 'ok', message: 'ok', durationMs: 842 };
    expect(formatProvisionLine('w1', step)).toBe(
      '[Worker w1] provision ok [readiness] bun run scripts/check-specs.ts --check — ok (842ms)',
    );
  });

  test('omits the duration suffix when none was recorded', () => {
    const step: StepResult = { phase: 'toolchain', label: 'bun', status: 'ok', message: 'found' };
    expect(formatProvisionLine('w1', step)).toBe('[Worker w1] provision ok [toolchain] bun — found');
  });

  test('carries durationMs on a failing step too', () => {
    const step: StepResult = { phase: 'install', label: 'bun install', status: 'fail', message: 'exit 1: boom', durationMs: 5012 };
    expect(formatProvisionLine('w1', step)).toBe(
      '[Worker w1] provision fail [install] bun install — exit 1: boom (5012ms)',
    );
  });
});

describe('role env degraded milestone label', () => {
  test('names the role and every missing key', () => {
    expect(formatRoleEnvDegradedLabel('builder', ['DATABASE_URL', 'VOYAGE_API_KEY'])).toBe(
      'Role env degraded: builder missing DATABASE_URL, VOYAGE_API_KEY',
    );
  });
});
