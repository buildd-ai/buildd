/**
 * Settings → Storage, mounted in happy-dom with a stubbed
 * /api/evidence-backends. Covers: a stored secret never reaches the page or
 * an input (even if the DTO carried one), form validation shown per field,
 * and the add / verify / remove handlers. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/storage', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: StorageSection } = await import('./StorageSection');
const { default: BackendForm } = await import('./BackendForm');
const { describeControls } = await import('../_lib/form-controls');

const ID = '22222222-2222-4222-8222-222222222222';
const LEAKED_ID = 'AKIALEAKEDLEAKED0000';
const LEAKED_SECRET = 'leaked-secret-value-do-not-render';
const LEAKED_TOKEN = 'leaked-session-token-do-not-render';

const BACKEND = {
  id: ID,
  workspaceId: null,
  provider: 's3',
  endpoint: null,
  region: 'us-east-1',
  bucket: 'acme-evidence',
  prefix: 'evidence',
  forcePathStyle: false,
  sse: 'none',
  kmsKeyId: null,
  retentionDays: 30,
  maxBytesPerTask: 8 * 1024 * 1024,
  status: 'failing',
  lastVerifiedAt: '2026-09-30T12:00:00.000Z',
  lastError: 'AccessDenied on PutObject',
  hasCredential: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
};

/** A DTO that should never exist: a backend carrying its credential. */
const POISONED = {
  ...BACKEND,
  accessKeyId: LEAKED_ID,
  secretAccessKey: LEAKED_SECRET,
  sessionToken: LEAKED_TOKEN,
  credentials: { accessKeyId: LEAKED_ID, secretAccessKey: LEAKED_SECRET, sessionToken: LEAKED_TOKEN },
  credentialSecretId: '33333333-3333-4333-8333-333333333333',
};

let list: Record<string, unknown>[] = [];
let canManage = true;
let verifyFails = false;
const requests: Array<{ url: string; method: string; body: unknown }> = [];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  list = [];
  canManage = true;
  verifyFails = false;
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/evidence-backends' && method === 'GET') return Response.json({ backends: list, canManage });
    if (url === '/api/evidence-backends' && method === 'POST') {
      const created = { ...BACKEND, id: '44444444-4444-4444-8444-444444444444', status: 'ok', lastError: null };
      list = [created];
      return Response.json({ backend: created, verification: { status: 'ok', error: null, warnings: [] } }, { status: 201 });
    }
    if (url.endsWith('/verify') && method === 'POST' && verifyFails) {
      // A failing check stores the same error as lastError, so the refreshed row carries it too.
      list = list.map((b) => ({ ...b, status: 'failing', lastError: 'AccessDenied on PutObject' }));
      return Response.json({ backendId: ID, status: 'failing', error: 'AccessDenied on PutObject', warnings: ['The probe object was readable without credentials.'], verifiedAt: '2026-10-01T00:00:00.000Z' });
    }
    if (url.endsWith('/verify') && method === 'POST') {
      list = list.map((b) => ({ ...b, status: 'ok', lastError: null }));
      return Response.json({ backendId: ID, status: 'ok', error: null, warnings: [], verifiedAt: '2026-10-01T00:00:00.000Z' });
    }
    if (method === 'DELETE') {
      list = [];
      return Response.json({ deleted: true, id: ID });
    }
    if (method === 'PATCH') return Response.json({ backend: list[0], verification: { status: 'ok', error: null } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(node: React.ReactNode = <StorageSection workspaces={[{ id: 'ws-1', name: 'Payments' }]} />) {
  await act(async () => { root.render(node); });
  await flush();
}

async function click(el: Element | null) {
  if (!el) throw new Error('element not found');
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}

const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
/** The confirm dialog's button: inside [role="dialog"], not the row's own "Remove". */
const dialogButton = (text: string) =>
  [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === text) ?? null;

function setInput(el: Element | null, v: string) {
  if (!el) throw new Error('input not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(testId: string) {
  const form = byTestId(testId) as HTMLFormElement;
  await act(async () => { form.requestSubmit(); });
  await flush();
}

function expectNoLeak() {
  const html = document.body.innerHTML;
  for (const s of [LEAKED_ID, LEAKED_SECRET, LEAKED_TOKEN]) expect(html).not.toContain(s);
  for (const input of document.body.querySelectorAll('input')) {
    for (const s of [LEAKED_ID, LEAKED_SECRET, LEAKED_TOKEN]) expect(input.value).not.toContain(s);
  }
}

describe('credentials are never rendered', () => {
  it('a DTO carrying a secret shows only "set", in the row and in the edit form', async () => {
    list = [POISONED];
    await mount();
    expectNoLeak();

    await click(document.body.querySelector(`[data-testid="storage-row-${ID}"] button[aria-expanded]`));
    expect(byTestId('storage-credential-flag')?.textContent).toBe('set');
    expectNoLeak();

    await click(byTestId('storage-edit'));
    expect(byTestId('storage-form-edit')).not.toBeNull();
    expect(byTestId('storage-credential-state')?.textContent).toContain('Credential set');
    const creds = [...document.body.querySelectorAll<HTMLInputElement>('input[data-credential-input]')];
    expect(creds.length).toBe(3);
    for (const input of creds) expect(input.value).toBe('');
    expectNoLeak();
  });

  it('BackendForm on its own never prefills a credential from the backend it edits', async () => {
    await mount(<BackendForm mode="edit" backend={POISONED as never} busy={false} onSubmit={() => {}} onCancel={() => {}} />);
    for (const input of document.body.querySelectorAll<HTMLInputElement>('input[data-credential-input]')) {
      expect(input.value).toBe('');
    }
    expectNoLeak();
  });

  it('saving an edit with blank credential fields keeps the stored one', async () => {
    list = [BACKEND];
    await mount();
    await click(document.body.querySelector(`[data-testid="storage-row-${ID}"] button[aria-expanded]`));
    await click(byTestId('storage-edit'));
    setInput(document.getElementById(`storage-edit-${ID}-retentionDays`), '60');
    await submit('storage-form-edit');
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.url).toBe(`/api/evidence-backends/${ID}`);
    expect(patch?.body).toEqual({ retentionDays: 60 });
  });
});

describe('form validation', () => {
  it('shows required fields for S3 and sends nothing', async () => {
    await mount();
    await click(byTestId('storage-add'));
    await submit('storage-form-create');
    for (const k of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
      expect(byTestId(`storage-error-storage-new-${k}`)?.textContent).toBeTruthy();
    }
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('refuses an http endpoint', async () => {
    await mount();
    await click(byTestId('storage-add'));
    setInput(document.getElementById('storage-new-endpoint'), 'http://s3.example.com');
    await submit('storage-form-create');
    expect(byTestId('storage-error-storage-new-endpoint')?.textContent).toContain('https');
  });
});

describe('add, verify, remove', () => {
  it('starts empty, adds a backend, then shows it verified', async () => {
    await mount();
    expect(byTestId('storage-empty')).not.toBeNull();
    await click(byTestId('storage-add'));
    setInput(document.getElementById('storage-new-bucket'), 'acme-evidence');
    setInput(document.getElementById('storage-new-region'), 'us-east-1');
    setInput(document.getElementById('storage-new-accessKeyId'), 'AKIAEXAMPLE');
    setInput(document.getElementById('storage-new-secretAccessKey'), 'example-secret-not-real');
    await submit('storage-form-create');

    const post = requests.find((r) => r.method === 'POST' && r.url === '/api/evidence-backends');
    expect(post?.body).toMatchObject({
      provider: 's3',
      bucket: 'acme-evidence',
      region: 'us-east-1',
      retentionDays: 30,
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret-not-real' },
    });
    expect((post?.body as Record<string, unknown>).workspaceId).toBeUndefined();
    expect(byTestId('storage-message')?.textContent).toContain('verified');
    expect(byTestId('storage-form-create')).toBeNull();
    expect(document.body.textContent).toContain('Verified');
    // The secret typed in does not stay on the page.
    expect(document.body.innerHTML).not.toContain('example-secret-not-real');
  });

  it('shows status, last error and the lifecycle rule; verify re-checks it', async () => {
    list = [BACKEND];
    await mount();
    await click(document.body.querySelector(`[data-testid="storage-row-${ID}"] button[aria-expanded]`));
    expect(document.body.textContent).toContain('Failing');
    expect(byTestId('storage-last-error')?.textContent).toContain('AccessDenied on PutObject');
    const lifecycle = byTestId('storage-lifecycle')?.textContent ?? '';
    expect(lifecycle).toContain('"Days": 30');
    expect(lifecycle).toContain('--bucket acme-evidence');

    await click(byTestId('storage-verify'));
    expect(requests.some((r) => r.method === 'POST' && r.url === `/api/evidence-backends/${ID}/verify`)).toBe(true);
    expect(byTestId('storage-message')?.textContent).toContain('Verified');
    // The result lands inside the row, next to the button that asked for it,
    // not below the card where a phone would have to scroll to find it.
    expect(document.body.querySelector(`[data-testid="storage-row-${ID}"] [data-testid="storage-message"]`)).not.toBeNull();
    expect(document.body.querySelectorAll('[data-testid="storage-message"]').length).toBe(1);
  });

  it('a failed verify shows its error once in the open row, not twice', async () => {
    list = [BACKEND];
    verifyFails = true;
    await mount();
    await click(document.body.querySelector(`[data-testid="storage-row-${ID}"] button[aria-expanded]`));
    await click(byTestId('storage-verify'));
    const row = document.body.querySelector(`[data-testid="storage-row-${ID}"]`)?.textContent ?? '';
    expect(row.split('AccessDenied on PutObject').length - 1).toBe(1);
    // The transient line still says the check just ran and failed.
    expect(byTestId('storage-message')?.textContent).toMatch(/failed/i);
    // Warnings after the error are kept.
    expect(byTestId('storage-message')?.textContent).toContain('readable without credentials');
  });

  it('remove confirms, then deletes', async () => {
    list = [BACKEND];
    await mount();
    await click(document.body.querySelector(`[data-testid="storage-row-${ID}"] button[aria-expanded]`));
    await click(byTestId('storage-remove'));
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(document.body.textContent).toContain('Remove the team default backend?');
    await click(dialogButton('Remove'));
    expect(requests.some((r) => r.method === 'DELETE' && r.url === `/api/evidence-backends/${ID}`)).toBe(true);
    expect(byTestId('storage-empty')).not.toBeNull();
  });

  it('a member reads each backend as text: no add, verify, edit or remove, and no who-can line', async () => {
    list = [BACKEND];
    canManage = false;
    await mount();
    expect(byTestId('storage-add')).toBeNull();
    expect(byTestId('storage-read-only')).toBeNull();
    expect(describeControls(host)).toEqual([]);
    await click(document.body.querySelector(`[data-testid="storage-row-${ID}"] button[aria-expanded]`));
    expect(byTestId('storage-details')!.textContent).toContain('acme-evidence');
    expect(byTestId('storage-edit')).toBeNull();
    expect(byTestId('storage-remove')).toBeNull();
    expect(byTestId('storage-verify')).toBeNull();
    // The lifecycle rule stays readable; copying it changes nothing.
    expect(byTestId('storage-lifecycle')).not.toBeNull();
    expect(describeControls(host)).toEqual(['button "Copy"', 'button "Copy"']);
    expect(host.textContent).not.toMatch(/Admins can|Only a team owner|can change this/);
  });

  it('a member with no backend reads the buildd default, with no control', async () => {
    canManage = false;
    await mount();
    expect(byTestId('storage-empty')).not.toBeNull();
    expect(describeControls(host)).toEqual([]);
    expect(host.textContent).not.toContain('Admins can');
  });
});
