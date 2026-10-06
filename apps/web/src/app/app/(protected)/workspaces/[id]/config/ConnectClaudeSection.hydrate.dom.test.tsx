/**
 * React error #418 on /app/workspaces/[id]/config: ConnectClaudeSection read
 * `window.location.origin` during render, so the server (no window) printed
 * one URL and the browser hydrated with another. The server HTML is rendered
 * here BEFORE any DOM exists, exactly as Next does it, then hydrated in a
 * browser whose origin differs.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { describe, expect, it } from 'bun:test';

const { renderToString } = await import('react-dom/server');
const { default: ConnectClaudeSection } = await import('./ConnectClaudeSection');

const props = { workspaceId: 'ws-example', workspaceName: 'Example', serverOrigin: 'https://app.example.test' };
const serverHtml = renderToString(<ConnectClaudeSection {...props} />);

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
GlobalRegistrator.register({ url: 'http://localhost:3000/app/workspaces/ws-example/config' });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { hydrateRoot } = await import('react-dom/client');

describe('ConnectClaudeSection hydration', () => {
  it('hydrates without a mismatch, then shows the browser origin', async () => {
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(container, <ConnectClaudeSection {...props} />, {
        onRecoverableError: (e) => errors.push(e),
      });
    });
    expect(errors.map(String)).toEqual([]);
    expect(serverHtml).toContain('https://app.example.test/api/mcp-oauth/ws-example');
    expect(container.textContent).toContain('http://localhost:3000/api/mcp-oauth/ws-example');
    act(() => root!.unmount());
  });
});
