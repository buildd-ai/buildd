/**
 * Unit tests for BYO evidence writers (apps/runner/src/evidence-writer.ts).
 * Spec: docs/specs/byo-evidence-storage.md — "What gets written", "Redaction", AC-2.
 *
 * Covers:
 *   - a failing Bash tool_result is redacted on the WHOLE text with the worker's
 *     secret list (BUILDD_API_KEY + mcpSecrets + roleEnvSecrets + the other
 *     claim-delivered channels), gzipped and PUT to a presigned URL;
 *   - a non-error (or non-Bash) tool_result writes nothing;
 *   - a refused upload URL (null), a missing client method, a throwing signer and
 *     a rejected PUT are all quiet — nothing throws into the session lifecycle;
 *   - the session-end test report is written with kind test_report;
 *   - every claim-delivered field on the runner's claim payload is classified, so
 *     a new secret channel cannot land without joining the redactor's list.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/evidence-writer.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecretRedactor } from '@buildd/core/redaction';

const logged: Array<{ level: string; event: string; detail?: string }> = [];

mock.module('../../src/session-logger', () => ({
  sessionLog: (_workerId: string, level: string, event: string, detail?: string) => {
    logged.push({ level, event, detail });
  },
  readSessionLogs: () => [],
}));

const {
  EvidenceWriter,
  buildWorkerSecretValues,
  CLAIM_FIELD_SECRET_CLASSIFICATION,
  TEST_REPORT_PATHS,
  MAX_EVIDENCE_GZ_BYTES,
  MAX_EVIDENCE_RAW_BYTES,
  headAndTail,
} = await import('../../src/evidence-writer');

const WORKER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Short, pattern-free values: only EXACT-value matching can remove them, so a
// pass proves the claim-delivered list reached the redactor (not a lucky
// generic credential pattern).
const RUNNER_KEY = 'RunKey7Plum';
const MCP_SECRET = 'McpSec9Fig';
const ROLE_SECRET = 'RoleEnv3Kiwi';

type Put = { url: string; body: Uint8Array; contentType: string; contentLength: number };

function makeDeps(overrides: Record<string, any> = {}) {
  const puts: Put[] = [];
  const requests: Array<{ workerId: string; req: { kind: string; seq: number; sizeBytes: number } }> = [];
  const deps = {
    requestEvidenceUploadUrl: async (workerId: string, req: { kind: string; seq: number; sizeBytes: number }) => {
      requests.push({ workerId, req });
      return { uploadUrl: `https://bucket.example/put/${req.kind}/${req.seq}`, key: `k/${req.kind}/${req.seq}.log.gz` };
    },
    put: async (url: string, body: Uint8Array, contentType: string, contentLength: number) => {
      puts.push({ url, body, contentType, contentLength });
      return true;
    },
    retryDelayMs: 0,
    ...overrides,
  };
  return { deps, puts, requests };
}

function makeWriter(deps: any) {
  const secrets = buildWorkerSecretValues(RUNNER_KEY, {
    mcpSecrets: { NOTION_TOKEN: MCP_SECRET },
    roleEnvSecrets: { DEPLOY_KEY: ROLE_SECRET },
  });
  return new EvidenceWriter({
    workerId: WORKER_ID,
    taskId: TASK_ID,
    redact: createSecretRedactor(secrets),
    deps,
  });
}

const gunzipText = (b: Uint8Array) => gunzipSync(b).toString('utf8');

beforeEach(() => {
  logged.length = 0;
});

describe('command_output evidence (AC-2)', () => {
  test('a failing Bash result is redacted on the whole text, gzipped and PUT', async () => {
    const { deps, puts, requests } = makeDeps();
    const writer = makeWriter(deps);
    const output = [
      'running deploy',
      `export API=${RUNNER_KEY}`,
      `mcp header: Bearer-less ${MCP_SECRET} trailing`,
      `role env DEPLOY_KEY=${ROLE_SECRET}`,
      // Far past any excerpt limit — the WHOLE text must be redacted.
      'x'.repeat(20_000),
      `late leak ${ROLE_SECRET}`,
      'error: exit code 1',
    ].join('\n');

    writer.onToolResult({ source: 'Bash', isError: true, text: output });
    await writer.drain();

    expect(requests).toHaveLength(1);
    expect(requests[0].workerId).toBe(WORKER_ID);
    expect(requests[0].req.kind).toBe('command_output');
    expect(requests[0].req.seq).toBe(0);

    expect(puts).toHaveLength(1);
    const put = puts[0];
    expect(put.contentLength).toBe(put.body.byteLength);
    expect(requests[0].req.sizeBytes).toBe(put.body.byteLength);

    const stored = gunzipText(put.body);
    expect(stored).not.toContain(RUNNER_KEY);
    expect(stored).not.toContain(MCP_SECRET);
    expect(stored).not.toContain(ROLE_SECRET);
    // Diagnostic value survives.
    expect(stored).toContain('running deploy');
    expect(stored).toContain('error: exit code 1');
    // Raw bytes on the wire are gzip, never the plain secret either.
    expect(Buffer.from(put.body).toString('latin1')).not.toContain(ROLE_SECRET);
  });

  test('seq increments per object for the worker', async () => {
    const { deps, requests } = makeDeps();
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom 1' });
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom 2' });
    await writer.drain();
    expect(requests.map(r => r.req.seq).sort()).toEqual([0, 1]);
  });

  test('a non-error tool_result writes nothing', async () => {
    const { deps, puts, requests } = makeDeps();
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: false, text: `ok ${MCP_SECRET}` });
    await writer.drain();
    expect(requests).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  test('a failing non-Bash tool_result writes nothing', async () => {
    const { deps, puts, requests } = makeDeps();
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Read', isError: true, text: 'ENOENT' });
    writer.onToolResult({ source: undefined, isError: true, text: 'unknown source' });
    await writer.drain();
    expect(requests).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  test('an empty failing Bash result writes nothing', async () => {
    const { deps, requests } = makeDeps();
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: '' });
    await writer.drain();
    expect(requests).toHaveLength(0);
  });

  test('a refused upload URL (null) is a quiet skip', async () => {
    const { deps, puts } = makeDeps({ requestEvidenceUploadUrl: async () => null });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    const outcomes = await writer.drain();
    expect(outcomes).toEqual(['skipped']);
    expect(puts).toHaveLength(0);
    expect(logged.some(l => l.level === 'error')).toBe(false);
  });

  test('a client without the upload method is a quiet skip', async () => {
    const { deps, puts } = makeDeps({ requestEvidenceUploadUrl: undefined });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['skipped']);
    expect(puts).toHaveLength(0);
  });

  test('a throwing signer or rejected PUT never throws into the caller', async () => {
    const throwing = makeWriter(makeDeps({
      requestEvidenceUploadUrl: async () => { throw new Error('network down'); },
    }).deps);
    expect(() => throwing.onToolResult({ source: 'Bash', isError: true, text: 'boom' })).not.toThrow();
    expect(await throwing.drain()).toEqual(['failed']);

    const syncThrowing = makeWriter(makeDeps({
      requestEvidenceUploadUrl: () => { throw new Error('sync throw'); },
    }).deps);
    expect(() => syncThrowing.onToolResult({ source: 'Bash', isError: true, text: 'boom' })).not.toThrow();
    expect(await syncThrowing.drain()).toEqual(['failed']);

    const rejected = makeWriter(makeDeps({ put: async () => false }).deps);
    rejected.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await rejected.drain()).toEqual(['failed']);

    const putThrows = makeWriter(makeDeps({ put: async () => { throw new Error('reset'); } }).deps);
    putThrows.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await putThrows.drain()).toEqual(['failed']);
  });

  test('a redactor that throws means nothing is uploaded (fail closed)', async () => {
    const { deps, puts } = makeDeps();
    const writer = new EvidenceWriter({
      workerId: WORKER_ID,
      redact: (() => { throw new Error('bad redactor'); }) as any,
      deps,
    });
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['failed']);
    expect(puts).toHaveLength(0);
  });
});

describe('failed uploads retry once', () => {
  test('a rejected PUT is retried once against the same URL and then lands', async () => {
    let calls = 0;
    const attempts: string[] = [];
    const { deps, requests } = makeDeps({
      put: async (url: string) => { calls++; attempts.push(url); return calls > 1; },
    });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['uploaded']);
    expect(requests).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
  });

  test('two rejected PUTs end failed after exactly two attempts', async () => {
    let calls = 0;
    const { deps } = makeDeps({ put: async () => { calls++; return false; } });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['failed']);
    expect(calls).toBe(2);
  });

  test('a signer that throws once is retried and the object lands', async () => {
    let signed = 0;
    const { deps, puts } = makeDeps({
      requestEvidenceUploadUrl: async (_w: string, req: { kind: string; seq: number }) => {
        if (signed++ === 0) throw new Error('network blip');
        return { uploadUrl: `https://bucket.example/put/${req.kind}/${req.seq}`, key: 'k' };
      },
    });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['uploaded']);
    expect(signed).toBe(2);
    expect(puts).toHaveLength(1);
  });

  test('a declined URL is not retried', async () => {
    let signed = 0;
    const { deps } = makeDeps({ requestEvidenceUploadUrl: async () => { signed++; return null; } });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['skipped']);
    expect(signed).toBe(1);
  });
});

describe('size cap keeps head and tail', () => {
  test('headAndTail leaves a short text alone', () => {
    expect(headAndTail('short', 1000)).toEqual({ text: 'short', omittedBytes: 0 });
  });

  test('headAndTail drops the middle on line boundaries and says how much', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${String(i).padStart(4, '0')}`);
    const out = headAndTail(lines.join('\n'), 4000);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(4000);
    expect(out.text.startsWith('line-0000\n')).toBe(true);
    expect(out.text.endsWith('line-1999')).toBe(true);
    expect(out.text).not.toContain('line-1000');
    expect(out.text).toContain(`[... ${out.omittedBytes} bytes omitted`);
    // No half lines at the seams.
    for (const l of out.text.split('\n')) expect(l === '' || l.startsWith('line-') || l.startsWith('[...')).toBe(true);
  });

  test('raw input over the ceiling keeps the first and last lines, not just the tail', async () => {
    const filler = 'x'.repeat(98) + '\n';
    const text = `HEAD-MARK first line\n${filler.repeat(Math.ceil((MAX_EVIDENCE_RAW_BYTES + 1024 * 1024) / filler.length))}TAIL-MARK last line`;
    const { deps, puts } = makeDeps();
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text });
    expect(await writer.drain()).toEqual(['uploaded']);
    const stored = gunzipText(puts[0].body);
    expect(stored).toContain('HEAD-MARK first line');
    expect(stored).toContain('TAIL-MARK last line');
    expect(stored).toContain('bytes omitted by the buildd evidence writer');
    expect(logged.some(l => l.event === 'evidence_truncated')).toBe(true);
  });

  test('an incompressible text over the gzip ceiling is shrunk to fit, not skipped', async () => {
    const b64 = randomBytes(12 * 1024 * 1024).toString('base64').replace(/(.{76})/g, '$1\n');
    const text = `HEAD-MARK\n${b64}\nTAIL-MARK`;
    const { deps, puts } = makeDeps();
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text });
    expect(await writer.drain()).toEqual(['uploaded']);
    expect(puts[0].body.byteLength).toBeLessThanOrEqual(MAX_EVIDENCE_GZ_BYTES);
    const stored = gunzipText(puts[0].body);
    expect(stored).toContain('HEAD-MARK');
    expect(stored).toContain('TAIL-MARK');
  });

  test('an oversized test report keeps its head and tail too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-writer-'));
    try {
      const filler = 'y'.repeat(98) + '\n';
      writeFileSync(
        join(dir, '.test-report.log'),
        `REPORT-HEAD\n${filler.repeat(Math.ceil((MAX_EVIDENCE_RAW_BYTES + 1024 * 1024) / filler.length))}REPORT-TAIL\n`,
      );
      const { deps, puts } = makeDeps();
      const writer = makeWriter(deps);
      expect(await writer.writeTestReport(dir)).toBe('uploaded');
      const stored = gunzipText(puts[0].body);
      expect(stored).toContain('REPORT-HEAD');
      expect(stored).toContain('REPORT-TAIL');
      expect(stored).toContain('bytes omitted by the buildd evidence writer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000); // builds and gzips a multi-MB report; slow when the machine is compiling
});

describe('confirming an upload', () => {
  function confirmDeps(over: Record<string, any> = {}) {
    const confirms: Array<{ workerId: string; evidenceId: string }> = [];
    const { deps, puts } = makeDeps({
      requestEvidenceUploadUrl: async (_w: string, req: { kind: string; seq: number }) =>
        ({ uploadUrl: `https://bucket.example/put/${req.seq}`, key: `k/${req.seq}`, evidenceId: `ev-${req.seq}` }),
      confirmEvidenceUpload: async (workerId: string, evidenceId: string) => { confirms.push({ workerId, evidenceId }); return true; },
      ...over,
    });
    return { deps, puts, confirms };
  }

  test('confirms the evidence id after a 2xx PUT', async () => {
    const order: string[] = [];
    const { deps, confirms } = confirmDeps({
      put: async () => { order.push('put'); return true; },
      confirmEvidenceUpload: async (workerId: string, evidenceId: string) => { order.push('confirm'); confirms.push({ workerId, evidenceId }); return true; },
    });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['uploaded']);
    expect(confirms).toEqual([{ workerId: WORKER_ID, evidenceId: 'ev-0' }]);
    expect(order).toEqual(['put', 'confirm']);
  });

  test('confirms the session-end test report too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-confirm-'));
    try {
      writeFileSync(join(dir, TEST_REPORT_PATHS[0]), '(fail) a > b\n');
      const { deps, confirms } = confirmDeps();
      expect(await makeWriter(deps).writeTestReport(dir)).toBe('uploaded');
      expect(confirms.map(c => c.evidenceId)).toEqual(['ev-0']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not confirm after a rejected or throwing PUT', async () => {
    for (const put of [async () => false, async () => { throw new Error('reset'); }]) {
      const { deps, confirms } = confirmDeps({ put });
      const writer = makeWriter(deps);
      writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
      expect(await writer.drain()).toEqual(['failed']);
      expect(confirms).toEqual([]);
    }
  });

  test('does not confirm when the server declined to sign', async () => {
    const { deps, confirms } = confirmDeps({ requestEvidenceUploadUrl: async () => null });
    const writer = makeWriter(deps);
    writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await writer.drain()).toEqual(['skipped']);
    expect(confirms).toEqual([]);
  });

  test('a failed or throwing confirm is best-effort: the upload still counts, nothing throws', async () => {
    for (const confirmEvidenceUpload of [
      async () => false,
      async () => { throw new Error('network down'); },
      () => { throw new Error('sync throw'); },
    ]) {
      const { deps } = confirmDeps({ confirmEvidenceUpload });
      const writer = makeWriter(deps);
      expect(() => writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' })).not.toThrow();
      expect(await writer.drain()).toEqual(['uploaded']);
    }
  });

  test('an older server with no evidence id, or a client with no confirm method, still uploads', async () => {
    const noId = confirmDeps({ requestEvidenceUploadUrl: async () => ({ uploadUrl: 'https://bucket.example/put', key: 'k' }) });
    const w1 = makeWriter(noId.deps);
    w1.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await w1.drain()).toEqual(['uploaded']);
    expect(noId.confirms).toEqual([]);

    const noMethod = confirmDeps({ confirmEvidenceUpload: undefined });
    const w2 = makeWriter(noMethod.deps);
    w2.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
    expect(await w2.drain()).toEqual(['uploaded']);
  });
});

describe('test_report evidence', () => {
  test('.test-report.log is the report path', () => {
    expect(TEST_REPORT_PATHS).toContain('.test-report.log');
  });

  test('an existing report is redacted, gzipped and PUT as test_report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-writer-'));
    try {
      writeFileSync(join(dir, '.test-report.log'), `FAIL foo.test.ts\nenv leaked ${MCP_SECRET} and ${RUNNER_KEY}\n`);
      const { deps, puts, requests } = makeDeps();
      const writer = makeWriter(deps);
      // A command_output first, so the report takes the next seq.
      writer.onToolResult({ source: 'Bash', isError: true, text: 'boom' });
      const outcome = await writer.writeTestReport(dir);
      await writer.drain();
      expect(outcome).toBe('uploaded');
      const req = requests.find(r => r.req.kind === 'test_report')!;
      expect(req).toBeDefined();
      expect(req.req.seq).toBe(1);
      const put = puts.find(p => p.url.includes('/test_report/'))!;
      const stored = gunzipText(put.body);
      expect(stored).toContain('FAIL foo.test.ts');
      expect(stored).not.toContain(MCP_SECRET);
      expect(stored).not.toContain(RUNNER_KEY);
      // The worktree file itself is left untouched.
      expect(readFileSync(join(dir, '.test-report.log'), 'utf8')).toContain(MCP_SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('queueTestReport reads the file before returning (worktree may be removed right after)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-writer-'));
    const { deps, puts } = makeDeps();
    const writer = makeWriter(deps);
    writeFileSync(join(dir, '.test-report.log'), `FAIL bar.test.ts ${ROLE_SECRET}\n`);
    writer.queueTestReport(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(await writer.drain()).toEqual(['uploaded']);
    const stored = gunzipText(puts[0].body);
    expect(stored).toContain('FAIL bar.test.ts');
    expect(stored).not.toContain(ROLE_SECRET);
  });

  test('no report file writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-writer-'));
    try {
      const { deps, requests } = makeDeps();
      const writer = makeWriter(deps);
      expect(await writer.writeTestReport(dir)).toBe('skipped');
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing cwd never throws', async () => {
    const writer = makeWriter(makeDeps().deps);
    expect(await writer.writeTestReport(undefined)).toBe('skipped');
    expect(await writer.writeTestReport('/definitely/not/a/real/dir/xyz')).toBe('skipped');
  });
});

describe('secret channel coverage', () => {
  test('buildWorkerSecretValues includes every claim-delivered secret channel', () => {
    const values = buildWorkerSecretValues('k-runner', {
      mcpSecrets: { A: 'v-mcp' },
      roleEnvSecrets: { B: 'v-role' },
      serverApiKey: 'v-server-api',
      serverOauthToken: 'v-server-oauth',
      claudeAccessToken: 'v-claude-access',
      codexCredential: { accessToken: 'v-cx-access', refreshToken: 'v-cx-refresh', idToken: 'v-cx-id', apiKey: 'v-cx-api', accountId: 'acct', expiresAt: null },
    });
    const got = values.map(v => v.value).sort();
    expect(got).toEqual([
      'k-runner', 'v-claude-access', 'v-cx-access', 'v-cx-api', 'v-cx-id', 'v-cx-refresh',
      'v-mcp', 'v-role', 'v-server-api', 'v-server-oauth',
    ].sort());
    // Empty/absent values are dropped, never an empty-string matcher.
    expect(buildWorkerSecretValues(undefined, { mcpSecrets: { A: '' } })).toEqual([]);
  });

  // Prompt text is not a credential, but it must never be echoed into evidence
  // or a public view: a skill body or role persona the agent cats out (or a
  // failing command prints) is redacted like one.
  test('skill bodies and the role persona are redacted from evidence', () => {
    expect(CLAIM_FIELD_SECRET_CLASSIFICATION.skillBundles).toBe('secret');
    expect(CLAIM_FIELD_SECRET_CLASSIFICATION.roleInstructions).toBe('secret');
    const skill = '---\nname: demo\ndescription: d\n---\nPrivate skill body that must not leak.';
    const values = buildWorkerSecretValues(undefined, {
      skillBundles: [{ slug: 'demo', content: skill }],
      roleInstructions: { slug: 'builder', content: 'You are the private persona text.' },
      roleBundle: { claudeMd: 'Private role CLAUDE.md text.', skills: [{ slug: 'rs', content: 'Private role skill text.' }] },
    }).map(v => v.value);
    expect(values).toContain(skill);
    expect(values).toContain('Private skill body that must not leak.');
    expect(values).toContain('You are the private persona text.');
    expect(values).toContain('Private role CLAUDE.md text.');
    expect(values).toContain('Private role skill text.');
  });

  test('every field of the runner claim payload is classified (a new secret channel fails here)', () => {
    // Parse the claim payload type literal from startFromClaim in workers.ts.
    const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');
    const anchor = src.indexOf('private async startFromClaim(');
    expect(anchor).toBeGreaterThan(-1);
    const open = src.indexOf('claimedWorker: {', anchor) + 'claimedWorker: '.length;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(open + 1, end);
    // Top-level keys only: track nesting depth over {}, <>, (), [].
    const keys: string[] = [];
    let d = 0;
    let token = '';
    for (const ch of body) {
      if ('{<(['.includes(ch)) d++;
      else if ('}>)]'.includes(ch)) d--;
      if (d === 0 && ch === ':') {
        const m = token.match(/([A-Za-z_$][\w$]*)\??\s*$/);
        if (m) keys.push(m[1]);
        token = '';
        continue;
      }
      if (d === 0 && ch === ';') { token = ''; continue; }
      if (d === 0) token += ch;
    }
    expect(keys.length).toBeGreaterThan(5);
    const unclassified = keys.filter(k => !(k in CLAIM_FIELD_SECRET_CLASSIFICATION));
    // If this fails: a claim field was added. Classify it in
    // CLAIM_FIELD_SECRET_CLASSIFICATION, and if it carries a secret add it to
    // buildWorkerSecretValues so the redactor (and evidence) covers it.
    expect(unclassified).toEqual([]);
  });

  test('every field classified as a secret actually reaches the redactor list', () => {
    const secretFields = Object.entries(CLAIM_FIELD_SECRET_CLASSIFICATION)
      .filter(([, c]) => c === 'secret')
      .map(([k]) => k);
    expect(secretFields.length).toBeGreaterThan(0);
    for (const field of secretFields) {
      const seeded: Record<string, unknown> = {
        mcpSecrets: { X: `seed-${field}` },
        roleEnvSecrets: { X: `seed-${field}` },
        codexCredential: { accessToken: `seed-${field}`, expiresAt: null },
        modelEndpoint: { kind: 'gateway', baseUrl: 'https://proxy.example', authToken: `seed-${field}`, authHeader: 'authorization', models: {} },
        roleInstructions: { slug: 'builder', name: 'Builder', content: `seed-${field}` },
        skillBundles: [{ slug: 'demo', name: 'Demo', content: `seed-${field}` }],
      };
      const worker = { [field]: seeded[field] ?? `seed-${field}` };
      const values = buildWorkerSecretValues(undefined, worker as any).map(v => v.value);
      expect(values).toContain(`seed-${field}`);
    }
  });
});
