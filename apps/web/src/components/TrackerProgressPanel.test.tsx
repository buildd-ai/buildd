import { describe, it, expect, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TrackerProgressPanel, {
  TrackerCard,
  fetchTrackerProgress,
  renderTrackerContent,
  type TrackerProgressResponse,
  type TrackerProgressItem,
} from './TrackerProgressPanel';

// NOTE: `fetch` is stubbed by direct assignment + restore (NOT mock.module), so
// nothing leaks across test files. See CLAUDE.md bun gotcha.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(impl(String(input)))) as typeof fetch;
}

const item = (over: Partial<TrackerProgressItem> = {}): TrackerProgressItem => ({
  kind: 'issue',
  externalId: 'ISS-1',
  title: 'Ship the thing',
  percent: 40,
  state: 'In Progress',
  url: 'https://linear.app/x/ISS-1',
  ...over,
});

describe('renderTrackerContent (render logic)', () => {
  it('shows a loading skeleton initially', () => {
    const html = renderToStaticMarkup(renderTrackerContent('loading', null));
    expect(html).toContain('tracker-skeleton');
    expect(html).toContain('animate-pulse');
  });

  it('renders null when linked === false', () => {
    const data: TrackerProgressResponse = {
      linked: false,
      provider: null,
      items: [],
      fetchedAt: '2026-07-25T00:00:00Z',
    };
    expect(renderToStaticMarkup(renderTrackerContent('done', data))).toBe('');
  });

  it('renders null on error (no error wall)', () => {
    expect(renderToStaticMarkup(renderTrackerContent('error', null))).toBe('');
  });

  it('renders a card with title + progress bar when items are present', () => {
    const data: TrackerProgressResponse = {
      linked: true,
      provider: 'linear',
      items: [item({ percent: 40 })],
      fetchedAt: '2026-07-25T00:00:00Z',
    };
    const html = renderToStaticMarkup(renderTrackerContent('done', data));
    expect(html).toContain('tracker-card');
    expect(html).toContain('Linear'); // provider label
    expect(html).toContain('Ship the thing'); // title
    expect(html).toContain('tracker-bar'); // progress bar present
    expect(html).toContain('width:40%'); // bar width from percent
    expect(html).toContain('40%');
    expect(html).toContain('In Progress'); // state label
    expect(html).toContain('https://linear.app/x/ISS-1'); // link out
  });
});

describe('TrackerCard (presentation edge cases)', () => {
  it('shows an em dash and no bar when percent is null', () => {
    const html = renderToStaticMarkup(
      <TrackerCard provider="linear" items={[item({ percent: null })]} />,
    );
    expect(html).toContain('—');
    expect(html).not.toContain('tracker-bar');
  });

  it('renders plain text (no link) when url is null', () => {
    const html = renderToStaticMarkup(
      <TrackerCard provider="linear" items={[item({ url: null })]} />,
    );
    expect(html).not.toContain('href=');
    expect(html).toContain('Ship the thing');
  });

  it('clamps out-of-range percent to 0..100', () => {
    const html = renderToStaticMarkup(
      <TrackerCard provider="linear" items={[item({ percent: 250 })]} />,
    );
    expect(html).toContain('width:100%');
  });
});

describe('fetchTrackerProgress (fetch contract, mocked)', () => {
  it('requests the correct URL for missions', async () => {
    let called = '';
    stubFetch((url) => {
      called = url;
      return new Response(
        JSON.stringify({ linked: false, provider: null, items: [], fetchedAt: 'x' }),
        { status: 200 },
      );
    });
    await fetchTrackerProgress('mission', 'm-123');
    expect(called).toBe('/api/missions/m-123/tracker-progress');
  });

  it('requests the correct URL for initiatives', async () => {
    let called = '';
    stubFetch((url) => {
      called = url;
      return new Response(
        JSON.stringify({ linked: true, provider: 'linear', items: [], fetchedAt: 'x' }),
        { status: 200 },
      );
    });
    await fetchTrackerProgress('initiative', 'i-9');
    expect(called).toBe('/api/initiatives/i-9/tracker-progress');
  });

  it('returns parsed data on 200', async () => {
    const payload: TrackerProgressResponse = {
      linked: true,
      provider: 'linear',
      items: [item()],
      fetchedAt: '2026-07-25T00:00:00Z',
    };
    stubFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const result = await fetchTrackerProgress('mission', 'm-1');
    expect(result).toEqual(payload);
  });

  it('returns null on a non-ok response', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    expect(await fetchTrackerProgress('mission', 'm-1')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('network'))) as typeof fetch;
    expect(await fetchTrackerProgress('mission', 'm-1')).toBeNull();
  });

  it('returns null on a malformed payload', async () => {
    stubFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    expect(await fetchTrackerProgress('mission', 'm-1')).toBeNull();
  });
});

describe('TrackerProgressPanel (SSR initial render)', () => {
  it('renders the skeleton before effects run', () => {
    const html = renderToStaticMarkup(
      <TrackerProgressPanel entityType="mission" entityId="m-1" />,
    );
    expect(html).toContain('tracker-skeleton');
  });
});
