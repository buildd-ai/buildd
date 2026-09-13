import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { LEDE_FIELD_SPEC, extractLede } from '../pr-lede';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

interface Call { endpoint: string; body: any }

function recordingApi(prNumber = 7) {
  const calls: Call[] = [];
  const api = (async (endpoint: string, init?: any) => {
    calls.push({ endpoint, body: init?.body ? JSON.parse(init.body) : null });
    if (endpoint === '/api/github/pr') {
      return {
        pr: {
          number: prNumber,
          title: 'feat: x',
          url: `https://github.com/o/r/pull/${prNumber}`,
          state: 'open',
        },
      };
    }
    return {};
  }) as unknown as ApiFn;
  return { api, calls };
}

function context(): ActionContext {
  return {
    workerId: 'w-1',
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
  } as ActionContext;
}

describe('create_pr — lede is required', () => {
  it('refuses a call with no lede, names the field, and creates NO PR', async () => {
    const { api, calls } = recordingApi();

    await expect(
      handleBuilddAction(api, 'create_pr', { title: 'feat: x', head: 'buildd/x' }, context()),
    ).rejects.toThrow(/lede/);

    // The throw happens before the HTTP call, so GitHub never hears about it.
    expect(calls.some((c) => c.endpoint === '/api/github/pr')).toBe(false);
  });

  it('rejects a blank lede the same way it rejects a missing one — absence, not judgement', async () => {
    const { api, calls } = recordingApi();
    await expect(
      handleBuilddAction(
        api,
        'create_pr',
        { title: 'feat: x', head: 'buildd/x', lede: '   ' },
        context(),
      ),
    ).rejects.toThrow(/lede/);
    expect(calls.some((c) => c.endpoint === '/api/github/pr')).toBe(false);
  });

  it('the rejection carries the full spec, so an in-flight worker can fix it in one retry', async () => {
    const { api } = recordingApi();
    let message = '';
    try {
      await handleBuilddAction(api, 'create_pr', { title: 'feat: x', head: 'buildd/x' }, context());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('No PR was created');
    expect(message).toContain('readable before coffee');
  });

  it('sends the lede to the PR route, which composes it into the body', async () => {
    const { api, calls } = recordingApi();
    const lede = 'An escalation that names a real defect can now dispatch the fix.';

    const res = await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: x', head: 'buildd/x', lede, body: '## Detail\n\nstuff' },
      context(),
    );

    expect(res.isError).toBeFalsy();
    const prCall = calls.find((c) => c.endpoint === '/api/github/pr')!;
    expect(prCall.body.lede).toBe(lede);
    expect(prCall.body.ledeDerived).toBe(false);
    expect(prCall.body.body).toBe('## Detail\n\nstuff');
  });

  it('normalizes a multi-line lede down to one bounded line before sending it', async () => {
    const { api, calls } = recordingApi();
    await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: x', head: 'buildd/x', lede: 'line one\n\nline two' },
      context(),
    );
    expect(calls.find((c) => c.endpoint === '/api/github/pr')!.body.lede).toBe('line one line two');
  });
});

describe('create_pr — the externally-created (prUrl) path gets a fallback, never a failure', () => {
  it('registers a PR opened outside buildd even with no lede', async () => {
    const { api, calls } = recordingApi(12);

    const res = await handleBuilddAction(
      api,
      'create_pr',
      {
        title: 'feat(specs): auto-file a friction task',
        head: 'buildd/x',
        prUrl: 'https://github.com/o/r/pull/12',
      },
      context(),
    );

    expect(res.isError).toBeFalsy();
    const prCall = calls.find((c) => c.endpoint === '/api/github/pr')!;
    // Deterministic: derived from the title, marked as derived.
    expect(prCall.body.lede).toBe('Auto-file a friction task.');
    expect(prCall.body.ledeDerived).toBe(true);
  });

  it('still prefers a real lede when the adopting caller supplies one', async () => {
    const { api, calls } = recordingApi(13);
    await handleBuilddAction(
      api,
      'create_pr',
      {
        title: 'feat: x',
        head: 'buildd/x',
        prUrl: 'https://github.com/o/r/pull/13',
        lede: 'A real sentence from the author.',
      },
      context(),
    );
    const prCall = calls.find((c) => c.endpoint === '/api/github/pr')!;
    expect(prCall.body.lede).toBe('A real sentence from the author.');
    expect(prCall.body.ledeDerived).toBe(false);
  });
});

describe('create_pr — the knowledge corpus gets the lede first too', () => {
  it('mirrors a lede-first body into the pr card', async () => {
    const upserts: any[] = [];
    const { api } = recordingApi(21);
    const ctx = {
      ...context(),
      knowledgeStore: {
        async upsert(namespace: string, chunks: any[]) { upserts.push({ namespace, chunks }); },
        async query() { return []; },
        async delete() {},
        async listNamespaces() { return []; },
      },
      embedder: null,
    } as unknown as ActionContext;

    await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: x', head: 'buildd/x', lede: 'The point, up front.', body: '## Detail\n\nstuff' },
      ctx,
    );

    const prUpsert = upserts.find((u) => u.namespace.endsWith(':pr'))!;
    const content: string = prUpsert.chunks[0].content;
    expect(content.indexOf('The point, up front.')).toBeLessThan(content.indexOf('## Detail'));
  });
});

describe('create_pr — params description', () => {
  it('documents lede as required and embeds the full spec with both examples', () => {
    const desc = buildParamsDescription(['create_pr']);
    expect(desc).toContain('lede (required');
    expect(desc).toContain(LEDE_FIELD_SPEC);
  });

  it('says plainly that nothing grades the prose — absence is the only failure', () => {
    const desc = buildParamsDescription(['create_pr']);
    expect(desc).toContain('only way `lede` can fail is by being absent');
  });

  it('documents the prUrl fallback so the adoption path is not a discovery', () => {
    const desc = buildParamsDescription(['create_pr']);
    expect(desc).toContain('derived from the title instead of refused');
  });
});

describe('extractLede is what makes the composed body readable back', () => {
  it('recovers the lede a create_pr body was composed with', () => {
    const composed = `<!-- buildd-lede -->\nThe point.\n<!-- /buildd-lede -->\n\n## Detail`;
    expect(extractLede(composed)?.lede).toBe('The point.');
  });
});
