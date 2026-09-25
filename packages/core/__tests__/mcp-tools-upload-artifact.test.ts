import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const MISSION_ID = '00000000-0000-0000-0000-000000000099';
const WORKER_ID = '00000000-0000-0000-0000-000000000055';

function ctx(): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    workerId: WORKER_ID,
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'worker',
  } as ActionContext;
}

function bodyOf(api: ReturnType<typeof mock>) {
  const [path, init] = api.mock.calls[0] as [string, { body: string }];
  expect(path).toBe('/api/artifacts/upload-url');
  return JSON.parse(init.body);
}

describe('upload_artifact — request body', () => {
  const upload = { artifactId: 'a1', uploadUrl: 'https://r2.example/put', downloadUrl: 'https://x/d', shareUrl: null };

  it('forwards missionId and metadata.qa for a visual-audit screenshot', async () => {
    const api = mock(() => Promise.resolve(upload));
    const qa = { runKey: 'run-1', route: '/app/missions', viewport: 'mobile', finding: 'Renders', verdict: 'ok' };
    await handleBuilddAction(
      api as unknown as ApiFn,
      'upload_artifact',
      { filename: 'm.png', mimeType: 'image/png', sizeBytes: 10, type: 'screenshot', missionId: MISSION_ID, metadata: { qa } },
      ctx(),
    );
    const body = bodyOf(api);
    expect(body.missionId).toBe(MISSION_ID);
    expect(body.metadata).toEqual({ qa });
    expect(body.type).toBe('screenshot');
    expect(body.workerId).toBe(WORKER_ID);
  });

  it('omits missionId when not given (the server inherits it from the task)', async () => {
    const api = mock(() => Promise.resolve(upload));
    await handleBuilddAction(
      api as unknown as ApiFn,
      'upload_artifact',
      { filename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      ctx(),
    );
    expect('missionId' in bodyOf(api)).toBe(false);
  });
});
