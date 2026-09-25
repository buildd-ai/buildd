/**
 * New-mission form on a phone (mobile QA): on a 320px screen the criterion
 * row's fields refused to shrink and pushed the remove ✕ off-screen, and every
 * field was under 16px, so iOS zoomed the page on focus.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/missions/new',
  useSearchParams: () => new URLSearchParams(''),
}));

const { default: NewMissionForm, CriterionRow } = await import('./NewMissionForm');
const { newCriterionDraft } = await import('@/lib/goal-criteria-form');

const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const classes = (el: string) => (el.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

function row(type: Parameters<typeof newCriterionDraft>[0]) {
  return renderToStaticMarkup(
    <CriterionRow draft={newCriterionDraft(type)} error={null} onChange={() => {}} onRemove={() => {}} />,
  );
}

describe('NewMissionForm — criterion row on a narrow phone', () => {
  for (const type of ['command', 'artifact_exists', 'description'] as const) {
    it(`every ${type} field can shrink and is 16px below md`, () => {
      const html = row(type);
      const fields = [...tags(html, 'input'), ...tags(html, 'select'), ...tags(html, 'textarea')];
      expect(fields.length).toBeGreaterThan(1);
      for (const f of fields) {
        const c = classes(f);
        expect(c).toContain('min-w-0');
        expect(c).toContain('text-base');
      }
    });
  }

  it('the remove ✕ never shrinks and is a 44px target', () => {
    const btn = tags(row('command'), 'button').find(b => b.includes('aria-label="Remove criterion"'))!;
    const c = classes(btn);
    expect(c).toContain('shrink-0');
    expect(c).toContain('min-h-11');
    expect(c).toContain('min-w-11');
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
