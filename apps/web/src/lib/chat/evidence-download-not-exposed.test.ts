/**
 * The evidence download link is dashboard-only (docs/specs/byo-evidence-storage.md,
 * "Read paths": "a short-lived presigned GET for download (UI only, never chat)").
 * Chat and MCP read evidence as redacted text; neither may ever reach the
 * download route or hand back a bucket URL.
 */
import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { allActions, handleBuilddAction, type ActionContext, type ApiFn } from '@buildd/core/mcp-tools';
import { CHAT_ROUTES, matchChatRoute } from './in-process-api';
import { ALL_CHAT_TOOL_SPECS, opsOf } from './registry';

const DOWNLOAD = '/api/evidence/download';
const WS = '00000000-0000-0000-0000-000000000001';
const TASK = '00000000-0000-0000-0000-000000000003';
const EV = '00000000-0000-0000-0000-0000000000e1';
const SIGNED = 'https://bucket.example.com/k.log.gz?X-Amz-Signature=abc&X-Amz-Expires=300';

const URLISH = /https?:\/\/|X-Amz-|presign/i;

describe('evidence download stays out of chat', () => {
  it('no chat tool op declares the download route', () => {
    const offenders: string[] = [];
    for (const [tool, spec] of Object.entries(ALL_CHAT_TOOL_SPECS)) {
      for (const [op, s] of opsOf(spec)) {
        if (s.routes.some(r => r.includes('/api/evidence/download'))) offenders.push(`${tool}.${op || '(single)'}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the in-process chat API cannot dispatch to it', () => {
    expect(matchChatRoute('GET', DOWNLOAD)).toBeNull();
    expect(CHAT_ROUTES.some(r => r.pattern.startsWith(DOWNLOAD))).toBe(false);
  });

  it('read_evidence is wired only to the text-returning read routes', () => {
    const spec = ALL_CHAT_TOOL_SPECS.read_evidence;
    const routes = opsOf(spec).flatMap(([, s]) => s.routes).filter(r => r.includes('evidence'));
    expect(routes.sort()).toEqual(['GET /api/evidence', 'GET /api/tasks/:id/evidence']);
  });
});

describe('evidence download stays out of MCP', () => {
  it('no MCP action is a download action', () => {
    expect(allActions.filter(a => /download|presign/i.test(a))).toEqual([]);
  });

  it('the MCP server and tool handlers never name the download route', () => {
    const root = join(import.meta.dir, '../../../../..');
    for (const f of ['packages/core/mcp-tools.ts', 'apps/web/src/app/api/mcp/route.ts']) {
      expect(readFileSync(join(root, f), 'utf8')).not.toContain(DOWNLOAD);
    }
  });

  const ctx: ActionContext = {
    workspaceId: WS, workerId: null as unknown as string, authType: 'oauth',
    getWorkspaceId: async () => WS, getLevel: async () => 'worker',
  };
  const obj = (over: Record<string, unknown> = {}) => ({
    id: EV, workspaceId: WS, taskId: TASK, rootTaskId: TASK, workerId: 'w', prNumber: null,
    kind: 'ci_job_log', bytes: 4096, uploadState: 'stored', indexState: 'skipped',
    createdAt: '2026-09-30T00:00:00.000Z', expiresAt: null, ...over,
  });

  it('read_evidence returns no URL, even if a route response carried one', async () => {
    // A hostile or future route response that grew a url field: the action
    // formats its own text and must not pass it through.
    const api = mock(async (path: string) => {
      expect(path).not.toContain(DOWNLOAD);
      if (path.includes('evidenceId=')) {
        return {
          taskId: TASK, workspaceId: WS, object: { ...obj(), url: SIGNED, downloadUrl: SIGNED },
          text: 'line one\nline two', truncated: false, cursor: null, fromLine: 1, toLine: 2,
          lineCount: 2, scannedLines: 2, scanLimited: false, url: SIGNED,
        };
      }
      return { taskId: TASK, workspaceId: WS, objects: [{ ...obj(), url: SIGNED, downloadUrl: SIGNED }] };
    });

    const list = await handleBuilddAction(api as unknown as ApiFn, 'read_evidence', { taskId: TASK }, ctx);
    const read = await handleBuilddAction(api as unknown as ApiFn, 'read_evidence', { taskId: TASK, tail: 50 }, ctx);
    for (const res of [list, read]) {
      const out = res.content.map(c => ('text' in c ? c.text : '')).join('\n');
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(URLISH);
    }
    expect(read.content.map(c => ('text' in c ? c.text : '')).join('\n')).toContain('line two');
  });
});
