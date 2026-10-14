/**
 * manage_specs attach and attachments (living-specs.md §21): an agent attaches
 * a file to a spec and reads the list back, each with the artifact id that
 * get_artifact reads (images included), over the specs attachments routes so
 * their reach checks apply. attach writes (tasks:write); attachments reads.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { requiredScopeForAction } from '../token-scopes';
import { SUB_ACTIONS } from '../mcp-sub-actions';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000061';
const ART = '00000000-0000-4000-8000-000000000062';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const out = (r: any) => String(r.content[0].text);
const view = (o: Record<string, unknown> = {}) => ({
  id: 'att-1', name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: ART, title: 'Pay screen', mimeType: 'image/png', isImage: true,
  artifactRevision: 2, addedInRevision: 3, removedFromRevision: null, addedBy: { kind: 'agent', name: null }, addedAt: '2026-10-13T00:00:00.000Z',
  url: `/api/specs/${SPEC}/attachments/pay-screen?revision=3`, approval: null, ...o,
});

describe('manage_specs attach / attachments', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('are registered sub-actions, documented, and scoped write / read', () => {
    expect(SUB_ACTIONS.manage_specs).toContain('attach');
    expect(SUB_ACTIONS.manage_specs).toContain('attachments');
    expect(buildParamsDescription(['manage_specs'])).toContain('"attach" | "attachments"');
    expect(requiredScopeForAction('manage_specs', { action: 'attach' })).toBe('tasks:write');
    expect(requiredScopeForAction('manage_specs', { action: 'attachments' })).toBe('tasks:read');
  });

  it('attach POSTs an existing artifact and says how to place and read it', async () => {
    api.mockResolvedValueOnce({ attachment: view(), upload: null });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attach', specId: SPEC, name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: ART }, ctx()));
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method]).toEqual([`/api/specs/${SPEC}/attachments`, 'POST']);
    expect(JSON.parse(opts.body)).toEqual({ name: 'pay-screen', kind: 'binding', caption: 'The pay screen', artifactId: ART });
    expect(r).toContain('![The pay screen](attachment:pay-screen)');
    expect(r).toContain(`get_artifact { artifactId: "${ART}" }`);
  });

  it('attach with a file starts an upload and returns the PUT', async () => {
    api.mockResolvedValueOnce({ attachment: view(), upload: { artifactId: ART, uploadUrl: 'https://upload.test/x' } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attach', specId: SPEC, name: 'pay-screen', kind: 'binding', filename: 'pay.png', mimeType: 'image/png', sizeBytes: 10 }, ctx()));
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ name: 'pay-screen', kind: 'binding', filename: 'pay.png', mimeType: 'image/png', sizeBytes: 10 });
    expect(r).toContain('curl -X PUT -H "Content-Type: image/png" --data-binary @pay.png "https://upload.test/x"');
  });

  it('attach passes a refusal through as an error, not a throw', async () => {
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"This spec already has an attachment named pay-screen."}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attach', specId: SPEC, name: 'pay-screen', kind: 'binding', artifactId: ART }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('already has an attachment');
  });

  it('attachments lists each with its artifact id and how it stands against approval', async () => {
    api.mockResolvedValueOnce({ revision: 3, attachments: [view({ approval: { state: 'changed', pinned: 2, current: 4 } }), view({ name: 'notes', kind: 'reference', isImage: false, mimeType: null, caption: null })] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attachments', specId: SPEC, revision: 3 }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/${SPEC}/attachments?revision=3`);
    expect(r).toContain('pay-screen (binding, image');
    expect(r).toContain('changed since approval');
    expect(r).toContain(`artifact ${ART}`);
    expect(r).toContain('notes (reference');

    api.mockResolvedValueOnce({ revision: 1, attachments: [] });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attachments', specId: SPEC }, ctx()))).toBe('No attachments on revision 1.');
  });
});
