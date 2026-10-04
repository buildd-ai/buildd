import { beforeEach, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

const id = '33333333-3333-4333-8333-333333333333';
const auth = mock(async (): Promise<any> => ({ id: 'account-test', teamId: 'team-test', level: 'admin' }));
const lookup = mock(async (): Promise<any> => worker);
const reader = mock(async (..._args: any[]): Promise<any> => ({ traceAvailability: 'full', records: [], source: null, missingPortions: [], reason: null }));
const worker = { id, accountId: 'account-test', workspaceId: 'workspace-test', status: 'completed', workspace: { teamId: 'team-test', dataClass: 'standard' } };
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: auth }));
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findFirst: lookup } } } }));
mock.module('@/lib/session-transcript', () => ({ readCompletedSessionTranscript: reader }));
import { GET } from './route';
const request = () => new NextRequest('http://localhost/api/workers/' + id + '/session-transcript', { headers: { authorization: 'Bearer bld_test' } });
const run = () => GET(request(), { params: Promise.resolve({ id }) });
beforeEach(() => {
  auth.mockReset(); lookup.mockReset(); reader.mockReset();
  auth.mockResolvedValue({ id: 'account-test', teamId: 'team-test', level: 'admin' });
  lookup.mockResolvedValue(worker);
  reader.mockResolvedValue({ traceAvailability: 'full', records: [], source: null, missingPortions: [], reason: null });
});
test('authorized internal read returns explicit coverage with no caching', async () => {
  const res = await run();
  expect(res.status).toBe(200);
  expect((await res.json()).traceAvailability).toBe('full');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(reader).toHaveBeenCalledTimes(1);
});
test('unauthenticated or non-admin callers cannot read transcripts', async () => {
  auth.mockResolvedValue(null);
  expect((await run()).status).toBe(401);
  auth.mockResolvedValue({ id: 'account-test', teamId: 'team-test', level: 'worker' });
  expect((await run()).status).toBe(403);
  expect(reader).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
});
test('ownership, team and workspace scope are required before reading', async () => {
  for (const override of [{ accountId: 'other' }, { workspace: { teamId: 'other', dataClass: 'standard' } }, { workspaceId: null }]) {
    lookup.mockResolvedValue({ ...worker, ...override });
    expect((await run()).status).toBe(403);
  }
  lookup.mockResolvedValue(worker);
  auth.mockResolvedValue({ id: 'account-test', teamId: 'team-test', level: 'admin', workspaceIds: ['other'] });
  expect((await run()).status).toBe(403);
  expect(reader).not.toHaveBeenCalled();
});
test('sensitive workspaces excluded before invoking reader', async () => {
  lookup.mockResolvedValue({ ...worker, workspace: { ...worker.workspace, dataClass: 'sensitive' } });
  expect((await run()).status).toBe(403);
  expect(reader).not.toHaveBeenCalled();
});
test('active and missing workers cannot be read', async () => {
  lookup.mockResolvedValue(null);
  expect((await run()).status).toBe(404);
  lookup.mockResolvedValue({ ...worker, status: 'working' });
  expect((await run()).status).toBe(409);
  expect(reader).not.toHaveBeenCalled();
});
test('absent, truncated and storage failures preserve coverage truth', async () => {
  for (const result of [
    { traceAvailability: 'absent', reason: 'object_missing' },
    { traceAvailability: 'absent', reason: 'read_failed' },
    { traceAvailability: 'truncated', missingPortions: ['malformed_records'], records: [{ type: 'output', line: 'usable' }] },
  ]) {
    reader.mockResolvedValue(result);
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  }
});
test('unexpected read and lookup failures do not expose backend errors', async () => {
  reader.mockRejectedValue(new Error('private backend details'));
  let res = await run();
  expect(res.status).toBe(503);
  expect(await res.text()).not.toContain('private');
  lookup.mockRejectedValue(new Error('private database details'));
  res = await run();
  expect(res.status).toBe(503);
  expect(await res.text()).not.toContain('private');
});
test('invalid worker identifiers never query or read', async () => {
  expect((await GET(request(), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(404);
  expect(lookup).not.toHaveBeenCalled();
});
