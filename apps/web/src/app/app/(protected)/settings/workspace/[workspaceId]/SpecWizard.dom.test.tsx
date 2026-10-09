/**
 * SpecWizard, mounted (happy-dom): the interview answers post as a dry run,
 * the rendered draft shows before confirm, and the route's issues surface.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>{children as never}</a>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SpecWizard } = await import('./SpecWizard');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; body: any }>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function setValue(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
}

function stub(respond: (body: any) => { status?: number; json: unknown }) {
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    calls.push({ url, body });
    const r = respond(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function fill() {
  setValue(q('spec-title')!, 'Example');
  setValue(q('spec-description')!, 'A thing');
  setValue(q('spec-capability-0-name')!, 'Charge once');
  setValue(q('spec-capability-0-invariants')!, 'never twice');
  setValue(q('spec-capability-0-accepted-when')!, 'pay');
  setValue(q('spec-capability-0-accepted-then')!, 'one charge');
  setValue(q('spec-capability-0-rejected-when')!, 'pay again');
  setValue(q('spec-capability-0-rejected-then')!, 'refused');
}

describe('SpecWizard', () => {
  it('previews the rendered draft before anything is created, then confirms the same answers', async () => {
    stub((body) => ({ json: { path: 'docs/specs/example.md', markdown: '# Example spec', warnings: [], dropped: [], ...(body.confirm ? { task: { id: 't1' } } : {}) } }));
    act(() => root.render(<SpecWizard workspaceId="ws-1" />));
    fill();

    act(() => { q('spec-wizard-preview-button')!.click(); });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/workspaces/ws-1/onboarding/spec');
    expect(calls[0].body.confirm).toBeUndefined();
    expect(calls[0].body.answers.title).toBe('Example');
    expect(calls[0].body.answers.capabilities[0].invariants).toEqual(['never twice']);
    expect(q('spec-wizard-preview-path')?.textContent).toBe('docs/specs/example.md');
    expect(q('spec-wizard-preview')?.textContent).toContain('# Example spec');

    act(() => { q('spec-wizard-confirm')!.click(); });
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1].body.confirm).toBe(true);
    expect(calls[1].body.answers).toEqual(calls[0].body.answers);
    expect(q('spec-wizard-created')?.textContent).toContain('docs/specs/example.md');
    expect(q('spec-wizard-mission-link')?.getAttribute('href')).toBe('/app/missions/new?workspace=ws-1');
  });

  it('keeps the form and lists the route issues when the answers are refused', async () => {
    stub(() => ({ status: 400, json: { error: 'Some answers need another look', issues: [{ question: 'Q1', message: 'Give the product a name.' }] } }));
    act(() => root.render(<SpecWizard workspaceId="ws-1" />));
    act(() => { q('spec-wizard-preview-button')!.click(); });
    await flush();
    expect(q('spec-wizard-error')?.textContent).toContain('Give the product a name.');
    expect(q('spec-wizard-preview')).toBeNull();
    expect(q('spec-title')).not.toBeNull();
  });

  it('adds a second capability', async () => {
    act(() => root.render(<SpecWizard workspaceId="ws-1" />));
    expect(q('spec-capability-1')).toBeNull();
    act(() => { q('spec-add-capability')!.click(); });
    expect(q('spec-capability-1')).not.toBeNull();
  });
});
