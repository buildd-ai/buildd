/**
 * Thin HTTP client for the Buildd Memory service.
 *
 * Used by:
 * - packages/core/mcp-tools.ts (handleMemoryAction)
 * - apps/mcp-server/src/index.ts (buildd_memory tool + workspace/memory resource)
 * - apps/local-ui/src/buildd.ts (observation methods → memory methods)
 * - apps/web claim route (context injection)
 * - apps/web dashboard memory page (via API proxy or direct)
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  teamId: string;
  type: 'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary';
  title: string;
  content: string;
  project: string | null;
  tags: string[];
  files: string[];
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  id: string;
  title: string;
  type: string;
  project?: string;
  tags?: string[];
  files?: string[];
  createdAt: string;
}

export interface SaveMemoryInput {
  type: string;
  title: string;
  content: string;
  project?: string;
  tags?: string[];
  files?: string[];
  source?: string;
}

export interface UpdateMemoryInput {
  type?: string;
  title?: string;
  content?: string;
  project?: string;
  tags?: string[];
  files?: string[];
  source?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class MemoryClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Memory API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Get markdown-formatted context for agent injection */
  async getContext(project?: string): Promise<{ markdown: string; count: number }> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : '';
    return this.request(`/api/memories/context${qs}`);
  }

  /** Search memories (compact index — no full content) */
  async search(params: {
    query?: string;
    type?: string;
    project?: string;
    files?: string[];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ results: MemorySearchResult[]; total: number; limit: number; offset: number }> {
    const sp = new URLSearchParams();
    if (params.query) sp.set('query', params.query);
    if (params.type) sp.set('type', params.type);
    if (params.project) sp.set('project', params.project);
    if (params.files?.length) sp.set('files', params.files.join(','));
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.offset) sp.set('offset', String(params.offset));
    const qs = sp.toString();
    return this.request(`/api/memories/search${qs ? `?${qs}` : ''}`);
  }

  /** Batch fetch full memory content by IDs */
  async batch(ids: string[]): Promise<{ memories: Memory[] }> {
    if (ids.length === 0) return { memories: [] };
    return this.request(`/api/memories/batch?ids=${ids.join(',')}`);
  }

  /** Get a single memory by ID */
  async get(id: string): Promise<{ memory: Memory }> {
    return this.request(`/api/memories/${id}`);
  }

  /** Save a new memory */
  async save(input: SaveMemoryInput): Promise<{ memory: Memory }> {
    return this.request('/api/memories', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** Update an existing memory */
  async update(id: string, fields: UpdateMemoryInput): Promise<{ memory: Memory }> {
    return this.request(`/api/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
  }

  /** Delete a memory */
  async delete(id: string): Promise<{ success: boolean }> {
    return this.request(`/api/memories/${id}`, {
      method: 'DELETE',
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _client: MemoryClient | null = null;

/**
 * Get a singleton MemoryClient configured from environment variables.
 * Returns null if MEMORY_API_URL or MEMORY_API_KEY is not set.
 */
export function getMemoryClient(): MemoryClient | null {
  if (_client) return _client;

  const url = process.env.MEMORY_API_URL;
  const key = process.env.MEMORY_API_KEY;
  if (!url || !key) return null;

  _client = new MemoryClient(url, key);
  return _client;
}
