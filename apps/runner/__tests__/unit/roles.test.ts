/**
 * Regression: `resolveRoleEnv` resolved a role's `env-mapping.json` against the
 * runner's process env, but a label with no match was only `console.warn`'d and
 * silently dropped — the caller had no way to tell "every declared var
 * resolved" apart from "some vars were dropped", so a role that declares a
 * requirement and loses it looked identical to a role that declared nothing.
 * Observed on the fleet as hundreds of `[roles]` warnings with sessions
 * starting anyway. `resolveRoleEnv` must report what it dropped so the caller
 * can record the session as degraded instead of silently proceeding.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/roles.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveRoleEnv } from '../../src/roles';

let roleDir: string;

beforeEach(() => {
  roleDir = mkdtempSync(join(tmpdir(), 'roles-test-'));
});

afterEach(() => {
  rmSync(roleDir, { recursive: true, force: true });
});

describe('resolveRoleEnv', () => {
  test('resolves every declared var when all secret labels are present', async () => {
    writeFileSync(
      join(roleDir, 'env-mapping.json'),
      JSON.stringify({ MY_KEY: 'SECRET_LABEL_A', OTHER_KEY: 'SECRET_LABEL_B' }),
    );
    const result = await resolveRoleEnv(roleDir, {
      SECRET_LABEL_A: 'value-a',
      SECRET_LABEL_B: 'value-b',
    });
    expect(result.resolved).toEqual({ MY_KEY: 'value-a', OTHER_KEY: 'value-b' });
    expect(result.missing).toEqual([]);
  });

  test('reports a declared-but-unavailable secret label in `missing`, not just a console warning', async () => {
    writeFileSync(
      join(roleDir, 'env-mapping.json'),
      JSON.stringify({ MY_KEY: 'SECRET_LABEL_A', GONE_KEY: 'SECRET_LABEL_MISSING' }),
    );
    const result = await resolveRoleEnv(roleDir, { SECRET_LABEL_A: 'value-a' });
    expect(result.resolved).toEqual({ MY_KEY: 'value-a' });
    expect(result.missing).toEqual(['GONE_KEY']);
  });

  test('empty env-mapping.json resolves cleanly with nothing missing', async () => {
    writeFileSync(join(roleDir, 'env-mapping.json'), JSON.stringify({}));
    const result = await resolveRoleEnv(roleDir, {});
    expect(result.resolved).toEqual({});
    expect(result.missing).toEqual([]);
  });

  test('no env-mapping.json at all resolves to empty, not an error', async () => {
    const result = await resolveRoleEnv(roleDir, { SECRET_LABEL_A: 'value-a' });
    expect(result.resolved).toEqual({});
    expect(result.missing).toEqual([]);
  });
});
