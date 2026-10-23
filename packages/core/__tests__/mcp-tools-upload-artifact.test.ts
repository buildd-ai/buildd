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

describe('upload_artifact — no worker in context', () => {
  it('sends missionId and no workerId from a session without a worker', async () => {
    const api = mock(() => Promise.resolve({ artifactId: 'a1', uploadUrl: 'u', downloadUrl: 'd', shareUrl: null }));
    const c = { ...ctx(), workerId: undefined } as ActionContext;
    await handleBuilddAction(api as unknown as ApiFn, 'upload_artifact', { filename: 'd.html', mimeType: 'text/html', sizeBytes: 10, missionId: MISSION_ID }, c);
    const body = bodyOf(api);
    expect('workerId' in body).toBe(false);
    expect(body.missionId).toBe(MISSION_ID);
  });

  it('still requires a worker when nothing scopes the upload', async () => {
    const api = mock(() => Promise.resolve({}));
    const c = { ...ctx(), workerId: undefined } as ActionContext;
    await expect(handleBuilddAction(api as unknown as ApiFn, 'upload_artifact', { filename: 'd.html', mimeType: 'text/html', sizeBytes: 10 }, c)).rejects.toThrow(/workerId is required/);
  });
});

describe('upload_artifact { artifactId } — finalize after the PUT', () => {
  it('posts to finalize with the sha256 and reports the verified state', async () => {
    const sha = 'a'.repeat(64);
    const api = mock(() => Promise.resolve({ artifactId: 'a1', state: 'ready', sha256: sha, sizeBytes: 10 }));
    const r = await handleBuilddAction(api as unknown as ApiFn, 'upload_artifact', { artifactId: 'a1', sha256: sha }, ctx());
    const [path, init] = api.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/api/artifacts/a1/finalize');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ sha256: sha });
    expect(r.content[0].text).toContain('Upload ready');
  });

  it('sends an empty body without a sha256 and needs no filename', async () => {
    const api = mock(() => Promise.resolve({ artifactId: 'a1', state: 'ready', sha256: null }));
    await handleBuilddAction(api as unknown as ApiFn, 'upload_artifact', { artifactId: 'a1' }, ctx());
    const [, init] = api.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({});
  });
});
