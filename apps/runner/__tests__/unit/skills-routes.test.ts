import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

describe('Skills Routes', () => {
  let server: any;
  let testPort: number;
  let baseUrl: string;

  // Mocked dependencies
  const mockListWorkspaceSkills = mock(() => Promise.resolve([
    { id: 'sk1', slug: 'skill1', name: 'Skill 1', enabled: true },
  ]));
  const mockPatchWorkspaceSkill = mock((wsId: string, skillId: string, data: any) =>
    Promise.resolve({ id: skillId, enabled: data.enabled })
  );
  const mockDeleteWorkspaceSkill = mock(() => Promise.resolve());

  // Mock BuilddClient
  const mockBuilddClient = {
    listWorkspaceSkills: mockListWorkspaceSkills,
    patchWorkspaceSkill: mockPatchWorkspaceSkill,
    deleteWorkspaceSkill: mockDeleteWorkspaceSkill,
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

        return new Response('Not found', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
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

  describe('CORS headers', () => {
    test('all routes return CORS headers', async () => {
      const endpoints = [
        { path: '/api/skills/list', method: 'POST', body: { workspaceId: 'ws1' } },
        { path: '/api/skills/toggle', method: 'POST', body: { workspaceId: 'ws1', skillId: 'sk1', enabled: true } },
        { path: '/api/skills/delete', method: 'DELETE', body: { workspaceId: 'ws1', skillId: 'sk1' } },
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
      const response = await fetch(`${baseUrl}/api/skills/list`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    });
  });
});
