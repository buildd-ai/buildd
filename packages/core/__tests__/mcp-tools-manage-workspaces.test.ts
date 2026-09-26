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
});
