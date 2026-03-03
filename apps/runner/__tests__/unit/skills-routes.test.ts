import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

describe('Skills Routes', () => {
  let server: any;
  let testPort: number;
  let baseUrl: string;

  // Mocked dependencies
  const mockScanSkills = mock(() => [
    { slug: 'test-skill', name: 'Test Skill', content: 'test', contentHash: 'abc123' },
  ]);
  const mockListWorkspaceSkills = mock(() => Promise.resolve([
    { id: 'sk1', slug: 'skill1', name: 'Skill 1', enabled: true },
  ]));
  const mockPatchWorkspaceSkill = mock((wsId: string, skillId: string, data: any) =>
    Promise.resolve({ id: skillId, enabled: data.enabled })
  );
  const mockDeleteWorkspaceSkill = mock(() => Promise.resolve());
  const mockSyncWorkspaceSkills = mock(() => Promise.resolve({ synced: 1, created: 1, updated: 0 }));

  // Mock BuilddClient
  const mockBuilddClient = {
    listWorkspaceSkills: mockListWorkspaceSkills,
    patchWorkspaceSkill: mockPatchWorkspaceSkill,
    deleteWorkspaceSkill: mockDeleteWorkspaceSkill,
    syncWorkspaceSkills: mockSyncWorkspaceSkills,
  };

  beforeAll(() => {
    // Find an available port
    testPort = 9876;
    baseUrl = `http://localhost:${testPort}`;

    // Create a minimal test server that mimics the skills routes from index.ts
    server = Bun.serve({
      port: testPort,
      development: false,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        // CORS headers
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (req.method === 'OPTIONS') {
          return new Response(null, { headers: corsHeaders });
        }

        // Parse JSON body helper
        async function parseBody(req: Request) {
          try {
            return await req.json();
          } catch {
            return {};
          }
        }

        // POST /api/skills/scan
        if (path === '/api/skills/scan' && req.method === 'POST') {
          const body = await parseBody(req);
          const localPath = body.localPath || '/default/path';

          if (!localPath || typeof localPath !== 'string') {
            return Response.json({ error: 'Invalid or missing localPath' }, { status: 400, headers: corsHeaders });
          }

          const skills = mockScanSkills(localPath);
          return Response.json({ skills }, { headers: corsHeaders });
        }

        // POST /api/skills/list
        if (path === '/api/skills/list' && req.method === 'POST') {
          const body = await parseBody(req);
          const { workspaceId, enabled } = body;

          if (!workspaceId) {
            return Response.json({ error: 'workspaceId required' }, { status: 400, headers: corsHeaders });
          }

          const skills = await mockBuilddClient.listWorkspaceSkills(workspaceId, enabled);
          return Response.json({ skills }, { headers: corsHeaders });
        }

        // POST /api/skills/toggle
        if (path === '/api/skills/toggle' && req.method === 'POST') {
          const body = await parseBody(req);
          const { workspaceId, skillId, enabled } = body;

          if (!workspaceId || !skillId || typeof enabled !== 'boolean') {
            return Response.json(
              { error: 'workspaceId, skillId, and enabled (boolean) required' },
              { status: 400, headers: corsHeaders }
            );
          }

          const skill = await mockBuilddClient.patchWorkspaceSkill(workspaceId, skillId, { enabled });
          return Response.json({ skill }, { headers: corsHeaders });
        }

        // DELETE /api/skills/delete
        if (path === '/api/skills/delete' && req.method === 'DELETE') {
          const body = await parseBody(req);
          const { workspaceId, skillId } = body;

          if (!workspaceId || !skillId) {
            return Response.json(
              { error: 'workspaceId and skillId required' },
              { status: 400, headers: corsHeaders }
            );
          }

          await mockBuilddClient.deleteWorkspaceSkill(workspaceId, skillId);
          return Response.json({ success: true }, { headers: corsHeaders });
        }

        // POST /api/skills/register
        if (path === '/api/skills/register' && req.method === 'POST') {
          const body = await parseBody(req);
          const { workspaceId, skill } = body;

          if (!workspaceId || !skill?.slug || !skill?.name || !skill?.content || !skill?.contentHash) {
            return Response.json(
              { error: 'workspaceId and skill (slug, name, content, contentHash) required' },
              { status: 400, headers: corsHeaders }
            );
          }

          const result = await mockBuilddClient.syncWorkspaceSkills(workspaceId, [
            {
              slug: skill.slug,
              name: skill.name,
              description: skill.description,
              content: skill.content,
              contentHash: skill.contentHash,
              source: skill.source || 'local-scan',
            },
          ]);
          return Response.json(result, { headers: corsHeaders });
        }

        return new Response('Not found', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop();
  });

  describe('POST /api/skills/scan', () => {
    test('returns skills from scanSkills()', async () => {
      const response = await fetch(`${baseUrl}/api/skills/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/test/path' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skills).toEqual([
        { slug: 'test-skill', name: 'Test Skill', content: 'test', contentHash: 'abc123' },
      ]);
      expect(mockScanSkills).toHaveBeenCalled();
    });

    test('uses default path when localPath not provided', async () => {
      const response = await fetch(`${baseUrl}/api/skills/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skills).toBeDefined();
    });

    test('returns 400 for invalid localPath type', async () => {
      const response = await fetch(`${baseUrl}/api/skills/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: 123 }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Invalid or missing localPath');
    });
  });

  describe('POST /api/skills/list', () => {
    test('returns skills for valid workspaceId', async () => {
      mockListWorkspaceSkills.mockClear();
      const response = await fetch(`${baseUrl}/api/skills/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skills).toEqual([
        { id: 'sk1', slug: 'skill1', name: 'Skill 1', enabled: true },
      ]);
      expect(mockListWorkspaceSkills).toHaveBeenCalledWith('ws1', undefined);
    });

    test('passes enabled filter to listWorkspaceSkills', async () => {
      mockListWorkspaceSkills.mockClear();
      await fetch(`${baseUrl}/api/skills/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1', enabled: true }),
      });

      expect(mockListWorkspaceSkills).toHaveBeenCalledWith('ws1', true);
    });

    test('returns 400 without workspaceId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId required');
    });

    test('returns 400 with null workspaceId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: null }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId required');
    });
  });

  describe('POST /api/skills/toggle', () => {
    test('toggles skill enabled status', async () => {
      mockPatchWorkspaceSkill.mockClear();
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skillId: 'sk1',
          enabled: false,
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skill).toEqual({ id: 'sk1', enabled: false });
      expect(mockPatchWorkspaceSkill).toHaveBeenCalledWith('ws1', 'sk1', { enabled: false });
    });

    test('returns 400 without workspaceId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: 'sk1', enabled: true }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId, skillId, and enabled (boolean) required');
    });

    test('returns 400 without skillId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1', enabled: true }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId, skillId, and enabled (boolean) required');
    });

    test('returns 400 without enabled field', async () => {
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1', skillId: 'sk1' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId, skillId, and enabled (boolean) required');
    });

    test('returns 400 when enabled is not a boolean', async () => {
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1', skillId: 'sk1', enabled: 'true' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId, skillId, and enabled (boolean) required');
    });

    test('returns 400 when enabled is null', async () => {
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1', skillId: 'sk1', enabled: null }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId, skillId, and enabled (boolean) required');
    });

    test('accepts enabled: true', async () => {
      mockPatchWorkspaceSkill.mockClear();
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skillId: 'sk1',
          enabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockPatchWorkspaceSkill).toHaveBeenCalledWith('ws1', 'sk1', { enabled: true });
    });

    test('accepts enabled: false', async () => {
      mockPatchWorkspaceSkill.mockClear();
      const response = await fetch(`${baseUrl}/api/skills/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skillId: 'sk1',
          enabled: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockPatchWorkspaceSkill).toHaveBeenCalledWith('ws1', 'sk1', { enabled: false });
    });
  });

  describe('DELETE /api/skills/delete', () => {
    test('deletes skill with valid params', async () => {
      mockDeleteWorkspaceSkill.mockClear();
      const response = await fetch(`${baseUrl}/api/skills/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skillId: 'sk1',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(mockDeleteWorkspaceSkill).toHaveBeenCalledWith('ws1', 'sk1');
    });

    test('returns 400 without workspaceId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: 'sk1' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skillId required');
    });

    test('returns 400 without skillId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skillId required');
    });

    test('returns 400 with null workspaceId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: null, skillId: 'sk1' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skillId required');
    });
  });

  describe('POST /api/skills/register', () => {
    test('registers skill with all required fields', async () => {
      mockSyncWorkspaceSkills.mockClear();
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            slug: 'new-skill',
            name: 'New Skill',
            description: 'A new skill',
            content: 'skill content',
            contentHash: 'hash123',
            source: 'local-scan',
          },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ synced: 1, created: 1, updated: 0 });
      expect(mockSyncWorkspaceSkills).toHaveBeenCalledWith('ws1', [
        {
          slug: 'new-skill',
          name: 'New Skill',
          description: 'A new skill',
          content: 'skill content',
          contentHash: 'hash123',
          source: 'local-scan',
        },
      ]);
    });

    test('uses default source when not provided', async () => {
      mockSyncWorkspaceSkills.mockClear();
      await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            slug: 'new-skill',
            name: 'New Skill',
            content: 'skill content',
            contentHash: 'hash123',
          },
        }),
      });

      expect(mockSyncWorkspaceSkills).toHaveBeenCalledWith('ws1', [
        expect.objectContaining({
          source: 'local-scan',
        }),
      ]);
    });

    test('returns 400 without workspaceId', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skill: {
            slug: 'new-skill',
            name: 'New Skill',
            content: 'content',
            contentHash: 'hash',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });

    test('returns 400 without skill object', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });

    test('returns 400 without skill.slug', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            name: 'New Skill',
            content: 'content',
            contentHash: 'hash',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });

    test('returns 400 without skill.name', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            slug: 'new-skill',
            content: 'content',
            contentHash: 'hash',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });

    test('returns 400 without skill.content', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            slug: 'new-skill',
            name: 'New Skill',
            contentHash: 'hash',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });

    test('returns 400 without skill.contentHash', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            slug: 'new-skill',
            name: 'New Skill',
            content: 'content',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });

    test('returns 400 with empty skill.slug', async () => {
      const response = await fetch(`${baseUrl}/api/skills/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws1',
          skill: {
            slug: '',
            name: 'New Skill',
            content: 'content',
            contentHash: 'hash',
          },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('workspaceId and skill (slug, name, content, contentHash) required');
    });
  });

  describe('CORS headers', () => {
    test('all routes return CORS headers', async () => {
      const endpoints = [
        { path: '/api/skills/scan', method: 'POST', body: { localPath: '/test' } },
        { path: '/api/skills/list', method: 'POST', body: { workspaceId: 'ws1' } },
        { path: '/api/skills/toggle', method: 'POST', body: { workspaceId: 'ws1', skillId: 'sk1', enabled: true } },
        { path: '/api/skills/delete', method: 'DELETE', body: { workspaceId: 'ws1', skillId: 'sk1' } },
        { path: '/api/skills/register', method: 'POST', body: { workspaceId: 'ws1', skill: { slug: 's', name: 'n', content: 'c', contentHash: 'h' } } },
      ];

      for (const endpoint of endpoints) {
        const response = await fetch(`${baseUrl}${endpoint.path}`, {
          method: endpoint.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(endpoint.body),
        });

        expect(response.headers.get('access-control-allow-origin')).toBe('*');
      }
    });

    test('OPTIONS requests return CORS headers', async () => {
      const response = await fetch(`${baseUrl}/api/skills/scan`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    });
  });
});
