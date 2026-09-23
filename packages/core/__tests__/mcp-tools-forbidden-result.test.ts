/**
 * A call above the caller's token level must return the same structured
 * {"error":"forbidden",...} shape everywhere — the admin gate
 * (requireAdminLevel), the worker gate (requireWorkerLevel), and the inline
 * manage_experiments write-op check all funnel through one forbiddenResult()
 * helper now. Companion to mcp-tools-admin-gated-actions.test.ts, which
 * covers the admin-level gate; this covers the worker-level gate and the
 * tool-description wording that used to conflate "wrong level" with "expired
 * auth" (both read as "401 means...").
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { handleBuilddAction, buildToolDescription, allActions, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';

function ctx(level: 'trigger' | 'worker' | 'admin'): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => level,
  };
}

const noopApi = (async () => ({})) as unknown as ApiFn;

describe('requireWorkerLevel — structured forbidden for trigger tokens', () => {
  it('trigger token calling claim_task gets a structured 403, not a bare string', async () => {
    const result = await handleBuilddAction(noopApi, 'claim_task', {}, ctx('trigger'));
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('forbidden');
    expect(body.requiredLevel).toBe('worker');
    expect(body.tokenLevel).toBe('trigger');
    expect(typeof body.reason).toBe('string');
  });

  it('worker token can call claim_task (not blocked by the worker-level gate)', async () => {
    const result = await handleBuilddAction(
      (async () => ({ workers: [] })) as unknown as ApiFn,
      'claim_task',
      {},
      ctx('worker'),
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('tool description wording — forbidden vs expired auth', () => {
  it('buildToolDescription points at the structured forbidden shape, not "means you lack admin level"', () => {
    const desc = buildToolDescription(allActions);
    expect(desc).toContain('{"error":"forbidden"');
    expect(desc).toMatch(/401 means auth expired/i);
  });

  it('no action description still claims a bare 401 means missing admin level (superseded by forbiddenResult)', () => {
    const source = readFileSync(path.join(__dirname, '../mcp-tools.ts'), 'utf8');
    expect(source).not.toMatch(/401 means token lacks admin level/);
  });
});
