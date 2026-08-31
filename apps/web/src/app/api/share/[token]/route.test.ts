import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockArtifactsFindFirst = mock(() => null as any);
const mockTrackEvent = mock((_event: string, _fields?: Record<string, unknown>) => {});

mock.module('@/lib/axiom', () => ({
  trackEvent: mockTrackEvent,
}));

// The route filters on both shareToken AND visibility='public'. Model that here so
// the test exercises the real gate rather than mocking it away.
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: {
        findFirst: (args: any) => mockArtifactsFindFirst(args),
      },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: { shareToken: 'shareToken', visibility: 'visibility' },
}));

import { GET } from './route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/share/tok-1', { method: 'GET' });
}

// Obviously fake, but distinctive enough to grep for in the telemetry payload.
const FAKE_TOKEN = 'shr_FAKE-not-a-real-token-000';

describe('GET /api/share/[token]', () => {
  beforeEach(() => {
    mockArtifactsFindFirst.mockReset();
    mockTrackEvent.mockReset();
  });

  it('returns 404 when token matches a private artifact (gate filters it out)', async () => {
    // Simulate the DB gate: a private artifact is never returned because the query
    // requires visibility='public'.
    mockArtifactsFindFirst.mockImplementation((args: any) => {
      const conds = args?.where?.conditions ?? [];
      const requiresPublic = conds.some(
        (c: any) => c?.field === 'visibility' && c?.value === 'public',
      );
      // A private row does not satisfy the public gate → no match.
      return requiresPublic ? null : { id: 'artifact-1' };
    });

    const res = await GET(createRequest(), { params: Promise.resolve({ token: 'tok-1' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Not found');
  });

  it('returns 200 with artifact when public', async () => {
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      type: 'content',
      title: 'Public Artifact',
      content: 'Body',
      metadata: {},
      visibility: 'public',
      shareToken: 'tok-1',
      createdAt: new Date('2026-01-01'),
      worker: { task: { id: 'task-1', title: 'T', status: 'completed' } },
    });

    const res = await GET(createRequest(), { params: Promise.resolve({ token: 'tok-1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.id).toBe('artifact-1');
    expect(data.artifact.title).toBe('Public Artifact');
  });

  // Regression: a share token is a bearer credential. `trackEvent` fields are
  // written verbatim to the telemetry sink (see lib/axiom.ts — no redaction,
  // no allowlist), so the raw token must never be handed to it.
  it('does not send the raw share token to telemetry on the miss path', async () => {
    mockArtifactsFindFirst.mockResolvedValue(null);

    const res = await GET(createRequest(), {
      params: Promise.resolve({ token: FAKE_TOKEN }),
    });
    expect(res.status).toBe(404);

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, fields] = mockTrackEvent.mock.calls[0];
    expect(event).toBe('api.share.request');
    expect(fields?.status).toBe('not_found');
    expect(JSON.stringify(fields ?? {})).not.toContain(FAKE_TOKEN);
  });

  it('does not send the raw share token to telemetry on the hit path', async () => {
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      type: 'content',
      title: 'Public Artifact',
      content: 'Body',
      metadata: {},
      visibility: 'public',
      shareToken: FAKE_TOKEN,
      createdAt: new Date('2026-01-01'),
      worker: { task: { id: 'task-1', title: 'T', status: 'completed' } },
    });

    const res = await GET(createRequest(), {
      params: Promise.resolve({ token: FAKE_TOKEN }),
    });
    expect(res.status).toBe(200);

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, fields] = mockTrackEvent.mock.calls[0];
    expect(event).toBe('api.share.request');
    expect(fields?.status).toBe('found');
    // A non-reversible identifier is fine (and useful); the credential is not.
    expect(fields?.artifactId).toBe('artifact-1');
    expect(JSON.stringify(fields ?? {})).not.toContain(FAKE_TOKEN);
  });
});
