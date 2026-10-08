import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, adminActions, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('manage_workspaces get', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('returns the current workspace config as lossless JSON', async () => {
    const config = {
      gitConfig: {
        autoMergePR: true,
        autoMergeMaxLines: 250,
        mergePolicy: { tier: 'agent-review', reviewerRoleSlug: 'reviewer' },
      },
      configStatus: 'configured',
      releaseConfig: null,
    };
    mockApi.mockResolvedValue(config);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_workspaces',
      { action: 'get', workspaceId: WORKSPACE_ID },
      createContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/config`);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      `Workspace ${WORKSPACE_ID} config:\n${JSON.stringify(config, null, 2)}`,
    );
  });

  it('uses the workspace from action context when workspaceId is omitted', async () => {
    mockApi.mockResolvedValue({
      gitConfig: null,
      configStatus: 'pending',
      releaseConfig: null,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_workspaces',
      { action: 'get' },
      createContext(),
    );

    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/config`);
  });

  it('passes gitConfig through verbatim whether or not onboarding config is present (AC-16)', async () => {
    for (const gitConfig of [
      { autoMergePR: true },
      { autoMergePR: true, onboarding: { waived: { 'build-command': { reason: 'no build step', at: '2026-01-01T00:00:00Z' } } } },
    ]) {
      const config = { gitConfig, configStatus: 'configured', releaseConfig: null };
      mockApi = mock().mockResolvedValue(config);

      const result = await handleBuilddAction(
        mockApi as unknown as ApiFn,
        'manage_workspaces',
        { action: 'get', workspaceId: WORKSPACE_ID },
        createContext(),
      );

      expect(result.content[0].text).toBe(
        `Workspace ${WORKSPACE_ID} config:\n${JSON.stringify(config, null, 2)}`,
      );
    }
  });

  it('requires a resolvable workspace', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'manage_workspaces',
        { action: 'get' },
        createContext({
          workspaceId: undefined,
          getWorkspaceId: async () => null,
        }),
      ),
    ).rejects.toThrow('workspaceId is required for get');

    expect(mockApi).not.toHaveBeenCalled();
  });
});

// Merge-policy paths are auto-detected (action=init). The hand-written fields
// are gone from the docs and refused before any API call.
describe('manage_workspaces — hand-written merge-policy paths removed', () => {
  const REMOVED = /autoMergeDenyPaths|escalateToPaths|userPaths|denyPaths/;

  it('param docs no longer mention the removed fields', () => {
    expect(buildParamsDescription(adminActions)).not.toMatch(REMOVED);
  });

  it('update refuses each removed field without calling the API', async () => {
    const cases: Array<Record<string, unknown>> = [
      { autoMergeDenyPaths: ['drizzle/'] },
      { gitConfig: { autoMergeDenyPaths: [] } },
      { gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'r', escalateToPaths: ['infra/'] } } } },
      { gitConfig: { mergePolicy: { tier: 'auto-threshold', threshold: { denyPaths: ['x/'] } } } },
      { gitConfig: { policyConfig: { preset: 'balanced', riskClasses: [{ name: 'ci_deploy_config', detectedPaths: [], userPaths: ['x'] }] } } },
    ];
    for (const extra of cases) {
      const api = mock();
      await expect(
        handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces', { action: 'update', workspaceId: WORKSPACE_ID, ...extra }, createContext()),
      ).rejects.toThrow(/no longer accepted.*Re-scan repo/s);
      expect(api).not.toHaveBeenCalled();
    }
  });

  it('update without them still goes through', async () => {
    const api = mock(async () => ({}));
    await handleBuilddAction(
      api as unknown as ApiFn,
      'manage_workspaces',
      { action: 'update', workspaceId: WORKSPACE_ID, gitConfig: { mergePolicy: { tier: 'human' } } },
      createContext(),
    );
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.parse((api.mock.calls[0] as any)[1].body)).toEqual({ gitConfig: { mergePolicy: { tier: 'human' } } });
  });

  it('init output does not tell the caller to type paths', async () => {
    const api = mock(async () => ({
      proposed: { preset: 'balanced', riskClasses: [{ name: 'ci_deploy_config', detectedPaths: ['.github/workflows/'] }] },
      repoFullName: 'acme/app',
      fileCount: 10,
      detectedClassCount: 1,
      hint: '',
      specConformance: {
        detected: { specsRoot: null, designRoot: null },
        proposed: { specsRoot: 'docs/specs', designRoot: 'docs/design' },
        hint: '',
        tier3Schedule: { params: { name: 'n', cronExpression: '0 0 * * 0', timezone: 'UTC', title: 't' }, hint: '' },
      },
    }));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces', { action: 'init', workspaceId: WORKSPACE_ID }, createContext());
    expect(result.content[0].text).not.toMatch(REMOVED);
  });

  it('init proposes detected lockfiles as derived files, and says nothing when there are none', async () => {
    const scan = (derivedFiles: unknown) => mock(async () => ({
      proposed: { preset: 'balanced', riskClasses: [] },
      repoFullName: 'acme/app',
      fileCount: 10,
      detectedClassCount: 0,
      hint: '',
      derivedFiles,
      specConformance: {
        detected: { specsRoot: null, designRoot: null },
        proposed: { specsRoot: 'docs/specs', designRoot: 'docs/design' },
        hint: '',
        tier3Schedule: { params: { name: 'n', cronExpression: '0 0 * * 0', timezone: 'UTC', title: 't' }, hint: '' },
      },
    }));
    const withLock = await handleBuilddAction(
      scan({ proposed: [{ glob: '/bun.lock', regenerate: 'bun install' }], hint: '' }) as unknown as ApiFn,
      'manage_workspaces', { action: 'init', workspaceId: WORKSPACE_ID }, createContext(),
    );
    const out = withLock.content[0].text;
    expect(out).toContain('## Proposed Derived Files');
    expect(out).toContain('/bun.lock → `bun install`');
    expect(out).toContain('gitConfig={ "derivedFiles": [{"glob":"/bun.lock","regenerate":"bun install"}] }');

    for (const none of [undefined, { proposed: [], hint: '' }]) {
      const r = await handleBuilddAction(scan(none) as unknown as ApiFn, 'manage_workspaces', { action: 'init', workspaceId: WORKSPACE_ID }, createContext());
      expect(r.content[0].text).not.toContain('Derived Files');
    }
  });
});

describe('manage_workspaces update — team changes go through the checked move', () => {
  // A workspace changes team only through the checked move; update must not
  // silently drop a teamId either, or the caller believes the move happened.
  for (const teamId of ['team-2', null]) {
    it(`refuses teamId=${JSON.stringify(teamId)} without calling the API and names the move endpoint`, async () => {
      const api = mock();
      await expect(
        handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces', { action: 'update', workspaceId: WORKSPACE_ID, name: 'x', teamId }, createContext()),
      ).rejects.toThrow(/migrate\/precheck/);
      expect(api).not.toHaveBeenCalled();
    });
  }

  it('update without teamId never sends one', async () => {
    const api = mock(async () => ({}));
    await handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces', { action: 'update', workspaceId: WORKSPACE_ID, name: 'x' }, createContext());
    expect(api).toHaveBeenCalledTimes(1);
    expect('teamId' in JSON.parse((api.mock.calls[0] as any)[1].body)).toBe(false);
  });
});

describe('manage_workspaces update — defaultBranch is persisted to gitConfig', () => {
  it('writes defaultBranch to gitConfig.defaultBranch', async () => {
    const api = mock(async () => ({}));
    await handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces', { action: 'update', workspaceId: WORKSPACE_ID, defaultBranch: 'canary' }, createContext());
    expect(api).toHaveBeenCalledTimes(1);
    const body = JSON.parse((api.mock.calls[0] as any)[1].body);
    // defaultBranch should be in gitConfig, not at the top level
    expect(body.gitConfig?.defaultBranch).toBe('canary');
    expect(body.defaultBranch).toBeUndefined();
  });

  it('merges defaultBranch with existing gitConfig', async () => {
    const api = mock(async () => ({}));
    await handleBuilddAction(
      api as unknown as ApiFn,
      'manage_workspaces',
      { action: 'update', workspaceId: WORKSPACE_ID, defaultBranch: 'staging', gitConfig: { autoMergePR: true } },
      createContext(),
    );
    expect(api).toHaveBeenCalledTimes(1);
    const body = JSON.parse((api.mock.calls[0] as any)[1].body);
    expect(body.gitConfig).toEqual({ autoMergePR: true, defaultBranch: 'staging' });
  });

  it('handles defaultBranch at create time too', async () => {
    const api = mock(async () => ({ id: 'ws-123', name: 'Test', repo: 'owner/repo' }));
    await handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces', { action: 'create', repoUrl: 'owner/repo', defaultBranch: 'main' }, createContext());
    expect(api).toHaveBeenCalledTimes(1);
    const body = JSON.parse((api.mock.calls[0] as any)[1].body);
    // At create time, defaultBranch should also go to gitConfig
    expect(body.gitConfig?.defaultBranch).toBe('main');
    expect(body.defaultBranch).toBeUndefined();
  });
});

describe('manage_workspaces readiness', () => {
  const report = {
    items: [
      { id: 'agent-instructions', status: 'detected', importance: 'core', evidence: [], fix: { kind: 'none', summary: 'Nothing to fix.' } },
      { id: 'spec-root', status: 'missing', importance: 'core', evidence: [], fix: { kind: 'scaffold', summary: 'Create a spec directory.', templateId: 'spec-root' } },
      { id: 'test-command', status: 'detected', importance: 'core', value: 'uv run pytest', evidence: [], fix: null },
      { id: 'build-command', status: 'unknown', importance: 'recommended', evidence: [], fix: null, waived: { reason: 'no build step', at: '2026-01-01T00:00:00Z' } },
    ],
    nextStep: 'propose-fixes',
    skill: 'workspace-onboarding',
    truncated: true,
  };

  const run = (mockApi: ReturnType<typeof mock>, params: Record<string, unknown> = { action: 'readiness', workspaceId: WORKSPACE_ID }) =>
    handleBuilddAction(mockApi as unknown as ApiFn, 'manage_workspaces', params, createContext());

  it('reads the readiness route with a single GET and reports nextStep and the skill to load', async () => {
    const mockApi = mock().mockResolvedValue(report);
    const result = await run(mockApi);

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0]).toEqual([`/api/workspaces/${WORKSPACE_ID}/readiness`]);
    const out = result.content[0].text;
    expect(out).toContain('Next step: propose-fixes');
    expect(out).toContain('Skill: workspace-onboarding');
    expect(out).toContain('truncated');
    expect(out).toContain('- [missing] spec-root (core) -> scaffold: Create a spec directory.');
    expect(out).toContain('- [detected] test-command (core) = uv run pytest');
    expect(out).toContain('(waived: no build step)');
    expect(out).not.toContain('Nothing to fix');
  });

  it("surfaces 'link-repo' for a workspace with no repo", async () => {
    const mockApi = mock().mockResolvedValue({ ...report, items: [], nextStep: 'link-repo', truncated: false });
    const result = await run(mockApi);
    expect(result.content[0].text).toContain('Next step: link-repo');
    expect(result.content[0].text).not.toContain('truncated');
  });

  it('uses the context workspace when workspaceId is omitted', async () => {
    const mockApi = mock().mockResolvedValue(report);
    await run(mockApi, { action: 'readiness' });
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/readiness`);
  });

  it('is named in the action docs and does not change what init calls', async () => {
    expect(buildParamsDescription(['manage_workspaces'])).toContain('action=readiness');
    const mockApi = mock().mockRejectedValue(new Error('no repo'));
    await run(mockApi, { action: 'init', workspaceId: WORKSPACE_ID });
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/policy-init`);
  });
});

describe('manage_workspaces author_spec', () => {
  const answers = { title: 'Checkout', description: 'Charges carts.', capabilities: [] };
  const run = (mockApi: ReturnType<typeof mock>, params: Record<string, unknown> = {}) =>
    handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_workspaces',
      { action: 'author_spec', workspaceId: WORKSPACE_ID, answers, ...params },
      createContext(),
    );

  it('posts the answers with confirm false by default and renders the draft', async () => {
    const mockApi = mock().mockResolvedValue({
      dryRun: true, path: 'docs/specs/checkout.md', format: 'default', warnings: ['domain defaulted'], markdown: '---\ntitle: Checkout\n---',
    });
    const result = await run(mockApi);

    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/onboarding/spec`);
    const body = JSON.parse((mockApi.mock.calls[0] as any)[1].body);
    expect(body).toEqual({ answers, confirm: false });
    const out = result.content[0].text;
    expect(out).toContain('Dry run: nothing created');
    expect(out).toContain('docs/specs/checkout.md');
    expect(out).toContain('- domain defaulted');
    expect(out).toContain('title: Checkout');
  });

  it('forwards confirm and owner and reports the created task', async () => {
    const mockApi = mock().mockResolvedValue({
      dryRun: false, path: 'docs/specs/checkout.md', format: 'mirrored', markdown: 'x', task: { id: 'abc', baseBranch: 'main' },
    });
    const result = await run(mockApi, { confirm: true, owner: 'octocat' });
    const body = JSON.parse((mockApi.mock.calls[0] as any)[1].body);
    expect(body).toEqual({ answers, owner: 'octocat', confirm: true });
    expect(result.content[0].text).toContain('Created task abc (PR base: main)');
    expect(result.content[0].text).not.toContain('```markdown');
  });

  it('is named in the action docs', () => {
    expect(buildParamsDescription(['manage_workspaces'])).toContain('action=author_spec');
  });
});

// Where a workspace's work runs (packages/shared/src/executor.ts).
describe('manage_workspaces update — gitConfig.executor', () => {
  it('passes a known value (or null to clear) through to the PATCH', async () => {
    for (const executor of ['cloud', 'host', 'any', null]) {
      const api = mock(async () => ({}));
      await handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces',
        { action: 'update', workspaceId: WORKSPACE_ID, gitConfig: { executor } }, createContext());
      expect(JSON.parse((api.mock.calls[0] as any)[1].body)).toEqual({ gitConfig: { executor } });
    }
  });

  it('refuses an unknown value without calling the API', async () => {
    const api = mock();
    await expect(
      handleBuilddAction(api as unknown as ApiFn, 'manage_workspaces',
        { action: 'update', workspaceId: WORKSPACE_ID, gitConfig: { executor: 'local' } }, createContext()),
    ).rejects.toThrow("gitConfig.executor must be 'cloud', 'host', 'any' or null");
    expect(api).not.toHaveBeenCalled();
  });

  it('is named in the action docs', () => {
    expect(buildParamsDescription(adminActions)).toContain('gitConfig.executor');
  });
});
