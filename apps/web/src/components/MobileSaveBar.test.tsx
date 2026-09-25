import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileSaveBar } from './MobileSaveBar';

const render = (p: Partial<Parameters<typeof MobileSaveBar>[0]> = {}) =>
  renderToStaticMarkup(<MobileSaveBar onSave={() => {}} saving={false} {...p} />);

describe('MobileSaveBar', () => {
  it('renders the given label', () => {
    expect(render({ label: 'Save role' })).toContain('>Save role<');
  });

  it('shows a save error inside the bar, where the user tapped', () => {
    const html = render({ error: 'Slug already taken' });
    expect(html).toMatch(/role="alert"[^>]*>Slug already taken</);
  });

  it('renders no alert when there is no error', () => {
    expect(render()).not.toContain('role="alert"');
  });

  it('acknowledges a successful save', () => {
    const html = render({ saved: true });
    expect(html).toContain('role="status"');
    expect(html).toContain('Saved');
  });

  it('says Saving while in flight', () => {
    expect(render({ saving: true })).toContain('Saving…');
  });
});
