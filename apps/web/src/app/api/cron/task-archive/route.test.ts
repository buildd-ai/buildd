import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDbExecute = mock(() => Promise.resolve({ rows: [] as any[] }));

mock.module('@buildd/core/db', () => ({
  db: { execute: mockDbExecute },
}));

mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
    { raw: (s: string) => ({ raw: s, type: 'sql' }) },
  ),
}));

process.env.CRON_SECRET = 'test-secret';

import { GET } from './route';

function makeRequest(auth = 'Bearer test-secret'): NextRequest {
  return new NextRequest('http://localhost/api/cron/task-archive', {
    headers: { authorization: auth },
  });
}

describe('GET /api/cron/task-archive', () => {
  beforeEach(() => {
    mockDbExecute.mockReset();
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it('returns 401 without the correct CRON_SECRET', async () => {
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    // Must not run the archive UPDATE for an unauthorized caller.
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('archives stale failed tasks and returns the count', async () => {
    mockDbExecute.mockResolvedValue({ rows: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.archived).toBe(3);
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (archived: 0) when nothing qualifies — idempotent re-runs', async () => {
    mockDbExecute.mockResolvedValue({ rows: [] });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(0);
  });

  it('targets only failed tasks and excludes deps of live tasks in the UPDATE', async () => {
    await GET(makeRequest());
    const call = mockDbExecute.mock.calls[0][0] as any;
    const query = call.strings.join(' ');
    // Only failed rows are archived (completed tasks are history — never touched).
    expect(query).toContain("status = 'failed'");
    expect(query).toContain("SET status = 'cancelled'");
    expect(query).not.toContain("status = 'completed'");
    // Skip tasks still depended on by non-terminal work.
    expect(query).toContain("dependent.status IN ('pending', 'assigned', 'in_progress')");
    expect(query).toContain('depends_on');
    // 30-day staleness window.
    expect(query).toContain("now() - interval");
  });
});
