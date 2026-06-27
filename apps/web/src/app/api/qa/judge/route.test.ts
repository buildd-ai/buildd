import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockFetch = mock(() => Promise.resolve({ ok: false } as any));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// Replace global fetch with the mock
(globalThis as any).fetch = mockFetch;

import { POST } from './route';

const VALID_ACCOUNT = { id: 'acc-1', level: 'worker' as const };

const MANIFEST = {
  routes: [
    {
      id: 'home',
      title: 'Home',
      path: '/app/home',
      specRef: 'spec/home.md',
      expectations: [
        { id: 'home-1', desc: 'Shows welcome message', specClaim: 'Displays a welcome header' },
      ],
    },
  ],
};

const CAPTURES = [
  {
    id: 'home',
    path: '/app/home',
    url: 'http://localhost:3000/app/home',
    finalUrl: 'http://localhost:3000/app/home',
    screenshotFile: 'home.png',
    a11yFile: 'home.json',
    capturedAt: '2024-01-01T00:00:00Z',
    a11yText: '{"role":"main","children":[{"role":"heading","name":"Welcome"}]}',
  },
];

function createRequest(body: unknown, apiKey?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/qa/judge', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    }),
    body: JSON.stringify(body),
  });
}

function mockClaudeResponse(verdict: object): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      content: [{ text: JSON.stringify(verdict) }],
    }),
  } as any);
}

describe('POST /api/qa/judge', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockFetch.mockReset();
  });

  it('returns 401 when no API key provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(createRequest({ captures: CAPTURES, manifest: MANIFEST }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when API key is invalid', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(createRequest({ captures: CAPTURES, manifest: MANIFEST }, 'bad-key'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when captures is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(VALID_ACCOUNT);

    const res = await POST(createRequest({ manifest: MANIFEST }, 'valid-key'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when manifest is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(VALID_ACCOUNT);

    const res = await POST(createRequest({ captures: CAPTURES }, 'valid-key'));
    expect(res.status).toBe(400);
  });

  it('returns verdicts and report on success', async () => {
    mockAuthenticateApiKey.mockResolvedValue(VALID_ACCOUNT);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    mockClaudeResponse({
      overallVerdict: 'PASS',
      summary: 'All expectations met',
      expectations: [
        { id: 'home-1', verdict: 'MATCHES-SPEC', evidence: 'Welcome header found' },
      ],
    });

    const res = await POST(createRequest({ captures: CAPTURES, manifest: MANIFEST }, 'valid-key'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.verdicts)).toBe(true);
    expect(data.verdicts).toHaveLength(1);
    expect(data.verdicts[0].id).toBe('home');
    expect(data.verdicts[0].overallVerdict).toBe('PASS');
    expect(data.verdicts[0].expectations[0].verdict).toBe('MATCHES-SPEC');
    expect(typeof data.report).toBe('string');
    expect(data.report).toContain('# Visual QA Report');

    // Verify Claude was called with OAuth bearer token
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-oauth-token');

    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('returns ERROR verdict when Claude is not configured', async () => {
    mockAuthenticateApiKey.mockResolvedValue(VALID_ACCOUNT);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const res = await POST(createRequest({ captures: CAPTURES, manifest: MANIFEST }, 'valid-key'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.verdicts[0].overallVerdict).toBe('ERROR');
    expect(data.verdicts[0].summary).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('returns SKIPPED verdict for skipped captures without calling Claude', async () => {
    mockAuthenticateApiKey.mockResolvedValue(VALID_ACCOUNT);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    const skippedCaptures = [
      {
        id: 'home',
        path: '/app/home',
        url: 'http://localhost:3000/app/home',
        capturedAt: '2024-01-01T00:00:00Z',
        skipped: true,
        skipReason: 'dynamic route — no CI fixture',
      },
    ];

    const res = await POST(createRequest({ captures: skippedCaptures, manifest: MANIFEST }, 'valid-key'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.verdicts[0].overallVerdict).toBe('SKIPPED');
    expect(mockFetch).not.toHaveBeenCalled();

    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('includes screenshot in Claude call when screenshotB64 is provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(VALID_ACCOUNT);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';

    mockClaudeResponse({
      overallVerdict: 'PASS',
      summary: 'OK',
      expectations: [{ id: 'home-1', verdict: 'MATCHES-SPEC', evidence: 'visible' }],
    });

    const capturesWithScreenshot = [
      { ...CAPTURES[0], screenshotB64: 'base64imagedata==' },
    ];

    await POST(createRequest({ captures: capturesWithScreenshot, manifest: MANIFEST }, 'valid-key'));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const reqBody = JSON.parse(init.body as string);
    const messages = reqBody.messages[0].content;
    expect(messages[0].type).toBe('image');
    expect(messages[0].source.data).toBe('base64imagedata==');

    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
});
