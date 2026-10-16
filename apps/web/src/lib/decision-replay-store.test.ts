import { describe, expect, it } from 'bun:test';
import { gunzipSync } from 'zlib';
import type { DecisionReplayInput, DecisionReplayLocator } from '@buildd/core/decision-replay';
import { createDecisionReplayStore, redactReplayValue, type DecisionReplayStoreDeps } from './decision-replay-store';
import type { ResolvedEvidenceBackend } from './evidence-backend';
import { buildDecisionReplayKey } from './storage-keys';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '33333333-3333-4333-8333-333333333333';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-01-05T10:00:00Z');

const backend = (over: Partial<ResolvedEvidenceBackend> = {}): ResolvedEvidenceBackend => ({
  source: 'team', backendId: 'b1', teamId: TEAM, workspaceId: null, provider: 'r2', bucket: 'team-bucket',
  endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', prefix: 'evidence', forcePathStyle: false,
  sse: 'none', kmsKeyId: null, retentionDays: 30, maxBytesPerTask: 8 * 1024 * 1024, status: 'verified',
  usable: true, problem: null, ...over,
} as ResolvedEvidenceBackend);

function harness(over: Partial<DecisionReplayStoreDeps> = {}) {
  const objects = new Map<string, Buffer>();
  const sent: any[] = [];
  let now = NOW;
  const client = {
    async send(cmd: any) {
      sent.push(cmd);
      const { Bucket, Key, Body } = cmd.input;
      if (cmd.constructor.name === 'PutObjectCommand') { objects.set(`${Bucket}/${Key}`, Body); return {}; }
      if (cmd.constructor.name === 'GetObjectCommand') {
        const b = objects.get(`${Bucket}/${Key}`);
        if (!b) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  const deps: DecisionReplayStoreDeps = {
    resolveBackend: async () => backend(),
    getClient: async () => client as any,
    loadWorkspace: async () => ({ dataClass: null }),
    serverSecretValues: () => ['super-secret-value-123'],
    now: () => now,
    ...over,
  };
  return { store: createDecisionReplayStore(deps), objects, sent, setNow: (d: Date) => { now = d; } };
}

const locator = (over: Partial<DecisionReplayLocator> = {}): DecisionReplayLocator => ({
  teamId: TEAM, workspaceId: WS, capability: 'orchestration_claim', decisionId: ID, askedAt: NOW, ...over,
});

const input = (over: Partial<DecisionReplayInput> = {}): DecisionReplayInput => ({
  capability: 'orchestration_claim',
  decisionId: ID,
  model: 'typesafe/jev-1.13',
  promptRef: { id: 'buildd.orchestration_claim_hold', version: '3', contentHash: 'abc' },
  state: { title: 'fix README', note: 'token ghp_abcdefghijklmnopqrstuvwxyz123456 and super-secret-value-123', files: 12, holder: ID },
  questionIds: ['pick'],
  candidates: ['START', 'HOLD'],
  ruleAnswer: 'HOLD',
  askedAt: NOW.toISOString(),
  source: 'orchestration_decisions',
  featureSchemaVersion: null,
  ...over,
});

describe('buildDecisionReplayKey', () => {
  it('places a copy beside the backend evidence, by team, kind and ledger id', () => {
    expect(buildDecisionReplayKey('evidence', TEAM, 'buildd.post_session_triage', ID))
      .toBe(`evidence/decision-replay/${TEAM}/buildd.post_session_triage/${ID}.json.gz`);
  });

  it('refuses a segment that could navigate', () => {
    expect(() => buildDecisionReplayKey('evidence', TEAM, '../x', ID)).toThrow();
    expect(() => buildDecisionReplayKey('evidence', '', 'k', ID)).toThrow();
  });
});

describe('decision replay store', () => {
  it('round-trips an input through the backend, gzipped, with the retention as its expiry', async () => {
    const h = harness();
    expect(await h.store.put(locator(), input())).toBe('stored');
    const put = h.sent[0];
    expect(put.input).toMatchObject({ Bucket: 'team-bucket', Key: `evidence/decision-replay/${TEAM}/orchestration_claim/${ID}.json.gz`, ContentEncoding: 'gzip' });
    const stored = JSON.parse(gunzipSync(put.input.Body).toString('utf8'));
    expect(stored.v).toBe(1);
    expect(stored.expiresAt).toBe('2026-02-04T10:00:00.000Z');
    const got = await h.store.get(locator());
    expect(got?.decisionId).toBe(ID);
    expect(got?.promptRef).toEqual({ id: 'buildd.orchestration_claim_hold', version: '3', contentHash: 'abc' });
  });

  it('redacts credentials and server secrets but keeps ids, numbers and the JSON shape', async () => {
    const h = harness();
    await h.store.put(locator(), input());
    const got = await h.store.get(locator());
    const state = got!.state as Record<string, unknown>;
    expect(state.note).not.toContain('ghp_');
    expect(state.note).not.toContain('super-secret-value-123');
    expect(state.files).toBe(12);
    expect(state.holder).toBe(ID);
    expect(state.title).toBe('fix README');
  });

  it('keeps nothing for a sensitive workspace, even on its own bucket', async () => {
    const h = harness({ loadWorkspace: async () => ({ dataClass: 'sensitive' }) });
    expect(await h.store.put(locator(), input())).toBe('skipped');
    expect(h.sent).toHaveLength(0);
    expect(await h.store.get(locator())).toBeNull();
  });

  it('skips when there is no usable backend, and when a team-level decision has no team backend', async () => {
    expect(await harness({ resolveBackend: async () => backend({ usable: false, problem: 'not configured' }) }).store.put(locator(), input())).toBe('skipped');
    expect(await harness({ resolveBackend: async () => null }).store.put(locator({ workspaceId: null }), input())).toBe('skipped');
  });

  it('skips a copy over the backend per-object limit', async () => {
    const h = harness({ resolveBackend: async () => backend({ maxBytesPerTask: 10 }) });
    expect(await h.store.put(locator(), input())).toBe('skipped');
  });

  it('reads an expired or missing copy as absent', async () => {
    const h = harness();
    expect(await h.store.get(locator())).toBeNull();
    await h.store.put(locator(), input());
    h.setNow(new Date('2026-02-05T00:00:00Z'));
    expect(await h.store.get(locator())).toBeNull();
  });

  it('never returns a copy stored under another id', async () => {
    const h = harness();
    await h.store.put(locator(), input({ decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    expect(await h.store.get(locator())).toBeNull();
  });
});

describe('redactReplayValue', () => {
  it('redacts strings at any depth and leaves other values alone', () => {
    const r = (s: string) => s.replace('x', '*');
    expect(redactReplayValue({ a: ['x1', { b: 'x2' }], n: 3, t: true, z: null }, r)).toEqual({ a: ['*1', { b: '*2' }], n: 3, t: true, z: null });
  });
});
