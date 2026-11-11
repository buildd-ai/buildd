/**
 * Knowledge health with the workspace's ingest switch off: the panel says
 * indexing is off (not "No index"), links to the setting, counts skipped
 * updates, and a job closed because of the switch reads "skipped", not "error".
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces/ws-1/memory', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: KnowledgeHealthSection } = await import('./KnowledgeHealthSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

function health(over: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    corpora: [{ corpus: 'code', currentChunks: 10 }],
    totalCurrentChunks: 10,
    lastIngestByRepo: [{
      repo: 'org/repo', sha: 'abcdef123', status: 'error', scope: 'diff', trigger: 'pr_merged',
      prNumber: 3, finishedAt: new Date().toISOString(), createdAt: new Date().toISOString(), error: 'ingest_disabled',
    }],
    pendingEntityRefs: 0,
    hasCodeIndex: true,
    lastSuccessfulIngestAt: null,
    staleAfterDays: 14,
    freshness: 'stale',
    ...over,
  };
}

function serve(payload: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

async function render() {
  await act(async () => { root.render(<KnowledgeHealthSection workspaceId="ws-1" />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

describe('KnowledgeHealthSection: ingest switch', () => {
  it('off: says indexing is off, links to the setting and counts skipped updates', async () => {
    serve({ health: health(), voyageBudget: null, ingest: { enabled: false, skippedJobs: 2 } });
    await render();
    const off = host.querySelector('[data-testid="knowledge-ingest-off"]');
    expect(off).not.toBeNull();
    expect(host.textContent).toContain('Indexing off');
    expect(host.textContent).not.toContain('Stale');
    expect(host.textContent).toContain('2 updates skipped while off.');
    const link = off!.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/app/settings/workspace/ws-1#knowledge-ingest');
    // A job the switch closed is "skipped", not an error.
    expect(host.textContent).toContain('skipped');
    expect(host.querySelector('.text-status-error')).toBeNull();
  });

  it('on (default): shows freshness as before, no off notice', async () => {
    serve({ health: health({ lastIngestByRepo: [] }), voyageBudget: null, ingest: { enabled: true, skippedJobs: 0 } });
    await render();
    expect(host.querySelector('[data-testid="knowledge-ingest-off"]')).toBeNull();
    expect(host.textContent).toContain('Stale');
  });
});
