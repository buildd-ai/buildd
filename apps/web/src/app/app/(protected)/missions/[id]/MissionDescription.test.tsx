/**
 * The mission description (F5): rendered as markdown, once, near the top of
 * the page, collapsed behind "Show more" when long. The Settings panel no
 * longer carries it (docs/design/mission-feed-mobile-continuity.md, S3 Built).
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { default: MissionDescription, DESCRIPTION_PREVIEW_CHARS } = await import('./MissionDescription');

const MARKDOWN = [
  '## Goal',
  '',
  'Make the **claim rail** hand each task its upstream state.',
  '',
  '- one row per dependency',
  '- `code` stays inline',
].join('\n');

/** The markup of the element carrying `testid`, from its opening tag. */
function tagOf(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  const open = html.lastIndexOf('<', at);
  return html.slice(open, html.indexOf('>', at) + 1);
}

describe('MissionDescription renders markdown', () => {
  it('turns headings, emphasis, lists and inline code into elements, not raw syntax', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription={MARKDOWN} />);
    expect(html).toContain('<h2');
    expect(html).toContain('<strong>claim rail</strong>');
    expect(html).toContain('<li');
    expect(html).toContain('<code');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('**claim rail**');
  });

  it('has one stable test id so the page can assert it appears once', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription={MARKDOWN} />);
    expect(html.split('data-testid="mission-description"').length - 1).toBe(1);
  });
});

describe('MissionDescription collapses long text', () => {
  const long = `${MARKDOWN}\n\n${'Paragraph of context. '.repeat(Math.ceil(DESCRIPTION_PREVIEW_CHARS / 10))}`;

  it('clamps a long description and offers Show more with a 44px target on mobile', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription={long} />);
    expect(html).toContain('Show more');
    expect(html).toContain('data-collapsed="true"');
    const toggle = tagOf(html, 'mission-description-toggle');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('min-h-11');
  });

  it('clips at a whole number of lines and fades the cut, whatever the background', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription={long} />);
    const clip = html.slice(html.lastIndexOf('<', html.indexOf('data-collapsed="true"')), html.indexOf('>', html.indexOf('data-collapsed="true"')) + 1);
    // 13px × leading-relaxed (1.625) ≈ 21px/line; 4 lines ≈ 5.25rem. max-h-24 cut mid-line.
    expect(clip).toContain('max-h-[5.25rem]');
    expect(clip).not.toContain('max-h-24');
    // A mask, not a surface-coloured overlay, so it works on any panel.
    expect(clip).toContain('[mask-image:linear-gradient(to_bottom,black_60%,transparent)]');
  });

  it('clamps a short description that has many lines', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `- item ${i}`).join('\n');
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription={lines} />);
    expect(html).toContain('data-collapsed="true"');
  });

  it('renders a short description in full with no toggle', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription="Short goal." />);
    expect(html).not.toContain('Show more');
    expect(html).not.toContain('data-collapsed="true"');
  });
});

describe('MissionDescription editing', () => {
  it('offers Edit (44px on mobile) beside a description', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription="Short goal." />);
    expect(tagOf(html, 'mission-description-edit')).toContain('min-h-11');
  });

  it('offers "Add a description" when empty and editable', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription={null} />);
    expect(html).toContain('Add a description');
    expect(tagOf(html, 'mission-description-edit')).toContain('min-h-11');
  });

  it('renders nothing when empty and read-only', () => {
    expect(renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription="  " readonly />)).toBe('');
  });

  it('hides Edit when read-only', () => {
    const html = renderToStaticMarkup(<MissionDescription missionId="m-1" initialDescription="Short goal." readonly />);
    expect(html).not.toContain('data-testid="mission-description-edit"');
  });
});
