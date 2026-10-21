/**
 * Regression test: Codex backend sandbox mode selection from the runner's isolation probe.
 *
 * When the host has no confinement for Codex, workspace-write and read-only both
 * fail every command. The backend falls back to danger-full-access only for a
 * run the runner decided reduced (trusted_local, operator opt-in), warning with
 * the cause; anything else refuses to start (Living Spec "Runner isolation", AC-5).
 *
 * Run: bun test apps/runner/__tests__/unit/backends/codex-sandbox-bwrap.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

let mockStartThread: ReturnType<typeof mock>;
let mockResumeThread: ReturnType<typeof mock>;
let mockRunStreamed: ReturnType<typeof mock>;

function makeEventStream(events: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

mockRunStreamed = mock(async (_prompt: string) => ({
  events: makeEventStream([]),
}));

mockStartThread = mock((_opts: any) => ({
  runStreamed: mockRunStreamed,
}));

mockResumeThread = mock((_threadId: string, _opts: any) => ({
  runStreamed: mockRunStreamed,
}));

const codexCtorOpts: any[] = [];

mock.module('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(opts: any) {
      codexCtorOpts.push(opts);
      return {
        startThread: mockStartThread,
        resumeThread: mockResumeThread,
      } as any;
    }
  },
}));

import { CodexBackend } from '../../../src/backends/codex-backend';

const BASE_OPTS = {
  prompt: 'hello',
  sessionId: 'sess-bwrap-test',
  cwd: '/tmp',
};

async function drain(gen: AsyncIterable<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {}
}

const BWRAP = { mechanism: 'bwrap', scope: ['write', 'network'] } as const;
const SEATBELT = { mechanism: 'seatbelt', scope: ['write', 'network'] } as const;
const DENIED = { mechanism: 'none', scope: [], reason: 'userns_sysctl_denied' } as const;

describe('CodexBackend sandbox mode — the confinement the runner probed for it', () => {
  beforeEach(() => {
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  const modeFor = async (opts: Record<string, unknown>) => {
    await drain(new CodexBackend().runStreamed({ ...BASE_OPTS, ...opts } as any));
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    return mockStartThread.mock.calls[0][0].sandboxMode;
  };

  test('uses workspace-write when bwrap confinement is available', async () => {
    expect(await modeFor({ sandboxConfinement: BWRAP })).toBe('workspace-write');
  });

  test('uses workspace-write when no confinement is passed (defaults to enforced)', async () => {
    expect(await modeFor({})).toBe('workspace-write');
  });

  test('uses read-only when bwrap confinement is available', async () => {
    expect(await modeFor({ sandboxMode: 'read-only', sandboxConfinement: BWRAP })).toBe('read-only');
  });

  // AC-5: on macOS Codex confines with Seatbelt; bwrap being absent there is
  // no reason to leave either mode.
  test('keeps workspace-write under Seatbelt (macOS, no bwrap)', async () => {
    expect(await modeFor({ sandboxConfinement: SEATBELT })).toBe('workspace-write');
  });

  test('keeps read-only under Seatbelt (macOS, no bwrap)', async () => {
    expect(await modeFor({ sandboxMode: 'read-only', sandboxConfinement: SEATBELT })).toBe('read-only');
  });

  // AC-5: an unconfined Codex never becomes danger-full-access unless the
  // runner decided the run reduced (trusted_local + operator opt-in, R-5).
  test('refuses to start an unconfined run that was not decided reduced, in either mode', async () => {
    for (const sandboxMode of ['workspace-write', 'read-only']) {
      mockStartThread.mockClear();
      await expect(drain(new CodexBackend().runStreamed({ ...BASE_OPTS, sandboxMode, sandboxConfinement: DENIED } as any)))
        .rejects.toThrow(/Not running with danger-full-access/);
      expect(mockStartThread).not.toHaveBeenCalled();
    }
  });

  test('falls back to danger-full-access only for a run decided reduced', async () => {
    expect(await modeFor({ sandboxConfinement: DENIED, allowReducedConfinement: true })).toBe('danger-full-access');
  });

  test('read-only mode also falls back for a run decided reduced', async () => {
    // Codex's 'read-only' sandbox mode still needs the host mechanism to
    // enforce the restriction (it isn't a no-op passed straight to the CLI).
    // On a host where it can't start, staying on 'read-only' fails every
    // exec_command before it runs — the failure a reviewer task hit.
    expect(await modeFor({ sandboxMode: 'read-only', sandboxConfinement: DENIED, allowReducedConfinement: true })).toBe('danger-full-access');
  });

  test('the opt-in never loosens a confined run', async () => {
    expect(await modeFor({ sandboxConfinement: BWRAP, allowReducedConfinement: true })).toBe('workspace-write');
  });

  test('the fallback warning names the cause, not a container-only fix', async () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await modeFor({ sandboxConfinement: DENIED, allowReducedConfinement: true });
    } finally {
      console.warn = warn;
    }
    const text = lines.join('\n');
    expect(text).toMatch(/unprivileged_userns_clone/);
    expect(text).toMatch(/danger-full-access/);
    expect(text).not.toMatch(/seccomp=unconfined/);
  });
});

describe("CodexBackend on Windows — Codex's own sandbox, named on every run", () => {
  const WIN = { mechanism: 'windows_restricted_token', scope: ['write'] } as const;

  beforeEach(() => {
    mockStartThread.mockClear();
    codexCtorOpts.length = 0;
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  const run = (opts: Record<string, unknown>) => drain(new CodexBackend().runStreamed({ ...BASE_OPTS, ...opts } as any));

  test('passes windows.sandbox="unelevated", so workspace-write is not silently read-only', async () => {
    await run({ sandboxConfinement: WIN });
    expect(mockStartThread.mock.calls[0][0].sandboxMode).toBe('workspace-write');
    expect(codexCtorOpts[0].config).toEqual({ windows: { sandbox: 'unelevated' } });
  });

  test('read-only keeps the same sandbox', async () => {
    await run({ sandboxMode: 'read-only', sandboxConfinement: WIN });
    expect(mockStartThread.mock.calls[0][0].sandboxMode).toBe('read-only');
    expect(codexCtorOpts[0].config).toEqual({ windows: { sandbox: 'unelevated' } });
  });

  test('other hosts get no Windows config', async () => {
    await run({ sandboxConfinement: BWRAP });
    expect(codexCtorOpts[0].config).toBeUndefined();
  });
});
