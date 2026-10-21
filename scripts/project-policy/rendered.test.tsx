import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMissionSections, SECTION_META } from '../../apps/web/src/lib/mission-sections';
import { TERMS } from '../../packages/shared/src/terms';
import { MissionCopyFixture, fixtureRows, SCHEDULED_AT } from './fixtures';

const ids = (html: string) => [...html.matchAll(/data-mission-id="([^"]+)"/g)].map(m => m[1]);

describe('project policy: independent rendered mission fixture', () => {
  it('reproduces the actual section captions before repair', () => {
    const html = renderToStaticMarkup(<MissionCopyFixture repaired={false} />);
    expect(html).toContain(SECTION_META.waiting.order);
    expect(html).toContain(SECTION_META.motion.order);
    expect(html).toContain('next to start first');
    expect(html).toContain('slipping first');
    expect(html).toContain('>Planning</span>');
  });

  it('removes captions while preserving the real section ordering', () => {
    const before = renderToStaticMarkup(<MissionCopyFixture repaired={false} />);
    const after = renderToStaticMarkup(<MissionCopyFixture repaired />);
    const expected = buildMissionSections(fixtureRows()).flatMap(s => s.rows.map(r => r.delivery.id));
    expect(ids(before)).toEqual(expected);
    expect(ids(after)).toEqual(expected);
    expect(expected).toEqual(['fix', 'quiet', 'fresh', 'queued', 'scheduled', 'held']);
    expect(after).not.toContain('mission-section-order');
    expect(after).not.toContain('next to start first');
    expect(after).not.toContain('slipping first');
  });

  it('renders truthful scheduled state/date and a real approval control', () => {
    const html = renderToStaticMarkup(<MissionCopyFixture repaired />);
    expect(html).toContain(`>${TERMS['wait.scheduled'].word}</span>`);
    expect(html).toContain(`<time dateTime="${SCHEDULED_AT}">`);
    expect(html).toContain('21 Oct 2026, 14:00 UTC');
    expect(html).not.toContain('>Planning</span>');
    expect(html).toContain('<button type="submit">Approve changes</button>');
    expect(html).toContain('action="/fixture/approve"');
  });
});
