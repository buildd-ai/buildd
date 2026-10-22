/**
 * New-mission form: every field 16px below md so iOS does not zoom on focus,
 * and no hand-written criteria on offer (Living Specs D-44).
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/missions',
  useSearchParams: () => new URLSearchParams('new=1'),
}));

const { default: NewMissionForm, DONE_WHEN_NOTE } = await import('./NewMissionForm');

const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const classes = (el: string) => (el.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

// Living Specs D-44: hand-written goal criteria are retired, so the form no
// longer offers them; "done" is the spec the mission selects.
describe('NewMissionForm — no hand-written criteria', () => {
  const html = renderToStaticMarkup(<NewMissionForm workspaces={[{ id: 'ws-1', name: 'Example' }]} />);

  it('offers no way to add a criterion', () => {
    expect(html).not.toContain('add-criterion-button');
    expect(html).not.toContain('criterion-row');
    expect(html).not.toContain('Add a criterion');
  });

  it('points at selecting a spec instead', () => {
    expect(html).toContain('mission-criteria-section');
    expect(DONE_WHEN_NOTE).toMatch(/spec/);
    expect(html).toContain(DONE_WHEN_NOTE);
  });
});

describe('NewMissionForm — main fields', () => {
  it('the name and description fields are 16px below md', () => {
    const html = renderToStaticMarkup(<NewMissionForm workspaces={[{ id: 'ws-1', name: 'Example' }]} />);
    const fields = [...tags(html, 'input'), ...tags(html, 'textarea')].filter(f => !f.includes('type="hidden"'));
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      const c = classes(f);
      expect(c).toContain('text-base');
      expect(c).not.toContain('text-sm');
    }
  });
});
