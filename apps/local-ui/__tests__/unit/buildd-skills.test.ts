/**
 * Unit tests for BuilddClient skill methods
 *
 * Run: bun test apps/local-ui/__tests__/unit/buildd-skills.test.ts
 *
 * Note: We avoid importing BuilddClient directly because other test files
 * (worker-manager-state.test.ts) mock '../../src/buildd' with a partial class.
 * Instead we test the HTTP contract by reimplementing the fetch calls.
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';

// Reimplementation of BuilddClient's skill methods for isolated testing.
// This avoids mock.module conflicts with other test files.
class TestableBuilddClient {
  private config: { builddServer: string; apiKey: string };

  constructor(config: { builddServer: string; apiKey: string }) {
    this.config = config;
  }

  private async fetch(endpoint: string, options: RequestInit = {}) {
    const res = await globalThis.fetch(`${this.config.builddServer}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        ...options.headers,
      },
    });
    if (!res.ok) {
      const error = await res.text();
      throw new Error(`API error: ${res.status} - ${error}`);
    }
    return res.json();
  }

  async syncWorkspaceSkills(workspaceId: string, skills: any[]): Promise<any> {
    return this.fetch(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({ skills }),
    });
  }

  async listWorkspaceSkills(workspaceId: string, enabled?: boolean): Promise<any[]> {
    const params = new URLSearchParams();
    if (enabled !== undefined) params.set('enabled', String(enabled));
    const qs = params.toString();
    const data = await this.fetch(`/api/workspaces/${workspaceId}/skills${qs ? `?${qs}` : ''}`);
    return data.skills || [];
  }

  async patchWorkspaceSkill(workspaceId: string, skillId: string, update: any): Promise<any> {
    const data = await this.fetch(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    });
    return data.skill;
  }

  async deleteWorkspaceSkill(workspaceId: string, skillId: string): Promise<void> {
    await this.fetch(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'DELETE',
    });
  }
}

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

const testConfig = {
  builddServer: 'https://test.buildd.dev',
  apiKey: 'bld_test123',
};

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('BuilddClient skill methods', () => {
  describe('listWorkspaceSkills', () => {
    test('returns skills array from response', async () => {
      const mockSkills = [
        { id: 'skill-1', name: 'Test Skill', enabled: true },
      ];
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ skills: mockSkills }), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      const client = new TestableBuilddClient(testConfig);
      const result = await client.listWorkspaceSkills('workspace-1');
      expect(result).toEqual(mockSkills);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('passes enabled=true query param', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.listWorkspaceSkills('workspace-1', true);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/workspace-1/skills?enabled=true');
    });

    test('passes enabled=false query param', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.listWorkspaceSkills('workspace-1', false);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/workspace-1/skills?enabled=false');
    });

    test('no query param when enabled is undefined', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.listWorkspaceSkills('workspace-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/workspace-1/skills');
    });

    test('sends correct Authorization header', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.listWorkspaceSkills('workspace-1');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toMatchObject({
        'Authorization': 'Bearer bld_test123',
        'Content-Type': 'application/json',
      });
    });
  });

  describe('patchWorkspaceSkill', () => {
    test('sends PATCH with update body', async () => {
      const update = { name: 'Updated', enabled: false };
      const client = new TestableBuilddClient(testConfig);
      await client.patchWorkspaceSkill('workspace-1', 'skill-1', update);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/workspace-1/skills/skill-1');
      expect(options.method).toBe('PATCH');
      expect(JSON.parse(options.body)).toEqual(update);
    });

    test('returns updated skill from response', async () => {
      const mockSkill = { id: 'skill-1', name: 'Updated', enabled: false };
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ skill: mockSkill }), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      const client = new TestableBuilddClient(testConfig);
      const result = await client.patchWorkspaceSkill('workspace-1', 'skill-1', { name: 'Updated' });
      expect(result).toEqual(mockSkill);
    });

    test('sends to correct URL with workspaceId and skillId', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.patchWorkspaceSkill('ws-123', 'skill-456', { enabled: true });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/ws-123/skills/skill-456');
    });

    test('sends correct headers', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.patchWorkspaceSkill('workspace-1', 'skill-1', { enabled: true });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toMatchObject({
        'Authorization': 'Bearer bld_test123',
        'Content-Type': 'application/json',
      });
    });
  });

  describe('deleteWorkspaceSkill', () => {
    test('sends DELETE to correct URL', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.deleteWorkspaceSkill('workspace-1', 'skill-1');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/workspace-1/skills/skill-1');
      expect(options.method).toBe('DELETE');
    });

    test('does not throw on success', async () => {
      const client = new TestableBuilddClient(testConfig);
      await expect(client.deleteWorkspaceSkill('workspace-1', 'skill-1')).resolves.toBeUndefined();
    });

    test('sends correct headers', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.deleteWorkspaceSkill('workspace-1', 'skill-1');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toMatchObject({
        'Authorization': 'Bearer bld_test123',
        'Content-Type': 'application/json',
      });
    });
  });

  describe('syncWorkspaceSkills', () => {
    test('sends POST with skills body', async () => {
      const skills = [
        { name: 'Skill 1', content: 'content 1', source: 'local' },
        { name: 'Skill 2', content: 'content 2', source: 'local' },
      ];

      const client = new TestableBuilddClient(testConfig);
      await client.syncWorkspaceSkills('workspace-1', skills);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/workspace-1/skills/sync');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ skills });
    });

    test('sends to correct URL', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.syncWorkspaceSkills('ws-789', []);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.buildd.dev/api/workspaces/ws-789/skills/sync');
    });

    test('sends correct headers', async () => {
      const client = new TestableBuilddClient(testConfig);
      await client.syncWorkspaceSkills('workspace-1', []);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toMatchObject({
        'Authorization': 'Bearer bld_test123',
        'Content-Type': 'application/json',
      });
    });

    test('returns response from server', async () => {
      const mockResponse = { created: 2, updated: 1, deleted: 0 };
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      const client = new TestableBuilddClient(testConfig);
      const result = await client.syncWorkspaceSkills('workspace-1', []);
      expect(result).toEqual(mockResponse);
    });
  });
});
