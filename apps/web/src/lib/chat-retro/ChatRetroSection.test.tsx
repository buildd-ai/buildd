import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { renderToStaticMarkup } = await import('react-dom/server');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatRetroSection, DogfoodActivationRow } = await import('./ChatRetroSection');
const { describeControls } = await import('@/app/app/(protected)/settings/_lib/form-controls');

describe('DogfoodActivationRow', () => {
  it('renders the copy and the Turn on button', () => {
    const html = renderToStaticMarkup(<DogfoodActivationRow onActivate={() => {}} />);
    expect(html).toContain('Keep on for every team I own');
    expect(html).toContain('>Turn on<');
  });

  it('keeps the Turn on tap target 44px tall on mobile, 32px on desktop', () => {
    const html = renderToStaticMarkup(<DogfoodActivationRow onActivate={() => {}} />);
    const button = html.match(/<button[^>]*>Turn on<\/button>/)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('md:h-8');
  });
});

describe('ChatRetroSection for a member', () => {
  it('explains the experiment with no control, no made-up On/Off and no admin line', async () => {
    const fetchMock = mock(async () => Response.json({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<ChatRetroSection teamId="t1" isAdmin={false} />); });
    try {
      expect(host.textContent).toContain('Chat session retros');
      expect(host.textContent).toContain('What is analysed');
      expect(describeControls(host)).toEqual([]);
      // A member cannot read the settings, so no value is shown for them.
      expect(host.querySelector('[data-testid="chat-retro-lessons-row"]')).toBeNull();
      expect(host.textContent).not.toMatch(/Admins can change|Only a team owner|can change this/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
