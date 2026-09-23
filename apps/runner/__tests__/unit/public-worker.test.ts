/**
 * Invariant: the runner's HTTP and SSE surfaces never serialise credential
 * material held on a LocalWorker.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  WORKER_FIELD_VISIBILITY,
  WITHHELD_WORKER_FIELDS,
  toPublicWorker,
  toPublicWorkers,
  toPublicEvent,
} from '../../src/public-worker';
import type { LocalWorker } from '../../src/types';

const SRC = join(import.meta.dir, '../../src');
const SENTINEL = 'sentinel-credential-value';

const CREDENTIAL_KEYS = [
  'mcpSecrets',
  'serverApiKey',
  'serverOauthToken',
  'claudeAccessToken',
  'claudeCredentialId',
  'codexCredential',
  'roleConfig',
  'assertionTokenCache',
] as const;

function workerWithCredentials(): LocalWorker {
  return {
    id: 'w-1',
    taskId: 't-1',
    taskTitle: 'Example',
    workspaceId: 'ws-1',
    workspaceName: 'example',
    workspaceDataClass: 'standard',
    branch: 'feature/x',
    status: 'working',
    hasNewActivity: false,
    startedAt: 1,
    lastActivity: 2,
    milestones: [],
    currentAction: 'Thinking',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    subagentTasks: [],
    subagentTasksObservedCount: 0,
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    mcpSecrets: { SOME_TOKEN: SENTINEL },
    serverApiKey: SENTINEL,
    serverOauthToken: SENTINEL,
    claudeAccessToken: SENTINEL,
    claudeCredentialId: SENTINEL,
    codexCredential: { accessToken: SENTINEL, refreshToken: SENTINEL, accountId: 'a', expiresAt: null },
    roleConfig: {
      slug: 'builder', configHash: 'h', configUrl: `https://example.invalid/?sig=${SENTINEL}`,
      type: 'builder', model: 'm', allowedTools: [], canDelegateTo: [], background: false, maxTurns: null,
    },
    assertionTokenCache: new Map([['c', { accessToken: SENTINEL, expiresAt: 0 }]]),
    // Set ad hoc on real workers, outside the LocalWorker type.
    ...({ mcpConnectors: [{ name: 'c', headers: { Authorization: `Bearer ${SENTINEL}` } }] } as any),
  } as LocalWorker;
}

/** Top-level field names of `export interface LocalWorker` in types.ts. */
function localWorkerFieldNames(): string[] {
  const src = readFileSync(join(SRC, 'types.ts'), 'utf8');
  const start = src.indexOf('export interface LocalWorker {');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start).split('\n');
  const names = new Set<string>();
  for (const line of body.slice(1)) {
    if (/^\}/.test(line)) break;
    const m = /^  ([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

describe('toPublicWorker', () => {
  it('emits no credential material', () => {
    const json = JSON.stringify(toPublicWorker(workerWithCredentials()));
    expect(json).not.toContain(SENTINEL);
    const out = toPublicWorker(workerWithCredentials()) as Record<string, unknown>;
    for (const k of CREDENTIAL_KEYS) expect(k in out).toBe(false);
    expect('mcpConnectors' in out).toBe(false);
  });

  it('keeps the fields the dashboard renders', () => {
    const out = toPublicWorker(workerWithCredentials());
    expect(out.id).toBe('w-1');
    expect(out.taskTitle).toBe('Example');
    expect(out.status).toBe('working');
    expect(out.currentAction).toBe('Thinking');
    expect(out.messages).toEqual([]);
  });

  it('projects lists', () => {
    const json = JSON.stringify({ workers: toPublicWorkers([workerWithCredentials(), workerWithCredentials()]) });
    expect(json).not.toContain(SENTINEL);
  });
});

describe('toPublicEvent', () => {
  it('projects the worker on worker_update', () => {
    const json = JSON.stringify(toPublicEvent({ type: 'worker_update', worker: workerWithCredentials() }));
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain('"type":"worker_update"');
    expect(json).toContain('"id":"w-1"');
  });

  it('projects a workers array', () => {
    const json = JSON.stringify(toPublicEvent({ type: 'init', workers: [workerWithCredentials()] }));
    expect(json).not.toContain(SENTINEL);
  });

  it('leaves non-worker elements of a workers array intact', () => {
    const ev = { type: 'x', workers: ['w-1', 'w-2'] };
    expect(toPublicEvent(ev)).toEqual(ev);
    const summaries = { type: 'x', workers: [{ id: 'w-1', name: 'a' }] };
    expect(toPublicEvent(summaries)).toEqual(summaries);
  });

  it('still projects worker-shaped elements mixed with other entries', () => {
    const json = JSON.stringify(toPublicEvent({ type: 'x', workers: ['w-0', workerWithCredentials()] }));
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain('"w-0"');
    expect(json).toContain('"id":"w-1"');
  });

  it('passes other events through unchanged', () => {
    const ev = { type: 'output', workerId: 'w-1', line: 'hi' };
    expect(toPublicEvent(ev)).toBe(ev);
  });
});

describe('WORKER_FIELD_VISIBILITY', () => {
  it('classifies every LocalWorker field (new fields must be classified deliberately)', () => {
    const unclassified = localWorkerFieldNames().filter((f) => !(f in WORKER_FIELD_VISIBILITY));
    expect(unclassified).toEqual([]);
  });

  it('withholds every credential field', () => {
    for (const k of CREDENTIAL_KEYS) expect(WORKER_FIELD_VISIBILITY[k]).toBe(false);
  });

  it('WITHHELD_WORKER_FIELDS (which PublicWorker omits) is exactly the withheld set', () => {
    const withheld = Object.keys(WORKER_FIELD_VISIBILITY).filter(
      (k) => !WORKER_FIELD_VISIBILITY[k as keyof typeof WORKER_FIELD_VISIBILITY],
    );
    expect([...WITHHELD_WORKER_FIELDS].sort()).toEqual(withheld.sort());
  });
});

describe('index.ts serialisation points', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');

  it('broadcast() projects every event before serialising', () => {
    const m = /function broadcast\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(index);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/JSON\.stringify\(toPublicEvent\(/);
  });

  it('/api/workers returns projected workers', () => {
    expect(index).toMatch(/workers:\s*toPublicWorkers\(workerManager!\.getWorkers\(\)\)/);
    expect(index).not.toMatch(/Response\.json\(\{\s*workers:\s*workerManager!\.getWorkers\(\)/);
  });

  it('/api/events init projects its workers', () => {
    const init = /const init = \{([\s\S]*?)\n      \};/.exec(index);
    expect(init).not.toBeNull();
    expect(init![1]).toMatch(/workers:\s*toPublicWorkers\(/);
  });

  it('no response serialises a raw worker', () => {
    expect(rawWorkerSerialisations(index)).toEqual([]);
  });
});

/**
 * Serialisation calls (`Response.json(`, `JSON.stringify(`, `new Response(`)
 * whose argument references a worker-named variable as a whole value (not a
 * property of it, not an object key) without a toPublicWorker(s) wrapper.
 */
function rawWorkerSerialisations(src: string): string[] {
  const hits: string[] = [];
  const call = /(?:Response\.json|JSON\.stringify|new Response)\(/g;
  const workerIdent = /(?<![.\w$])(w|worker|workers|\w+Worker|\w+Workers)\b(?!\s*(?:[.:\[(]|\?\.))/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const arg = src
      .slice(start, i - 1)
      .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""')
      .replace(/toPublicWorkers?\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '0');
    if (workerIdent.test(arg)) hits.push(arg.trim());
    workerIdent.lastIndex = 0;
  }
  return hits;
}

describe('rawWorkerSerialisations (the guard itself)', () => {
  const flagged = [
    'Response.json({ worker }, { headers })',
    'Response.json({ worker, ok: true })',
    'Response.json({ worker: worker })',
    'Response.json({ worker: w })',
    'Response.json(worker)',
    'new Response(JSON.stringify(worker))',
    'Response.json({ workers: workerManager!.getWorkers().map(x => x), list: allWorkers })',
    'JSON.stringify({ data: targetWorker })',
  ];
  const clean = [
    'Response.json({ worker: toPublicWorker(worker) }, { headers })',
    'Response.json({ workers: toPublicWorkers(workerManager!.getWorkers()) })',
    'Response.json({ checkpoints: worker.checkpoints || [] })',
    'Response.json({ team: worker.teamState || null })',
    "Response.json({ error: 'Worker not found' }, { status: 404 })",
    'Response.json({ toolCalls: worker.toolCalls, messages: worker?.messages })',
    'JSON.stringify(toPublicEvent(event))',
  ];
  for (const s of flagged) it(`flags ${s}`, () => expect(rawWorkerSerialisations(s)).not.toEqual([]));
  for (const s of clean) it(`allows ${s}`, () => expect(rawWorkerSerialisations(s)).toEqual([]));
});
