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

  describe('with dirty tracking', () => {
    it('renders nothing when the form is clean and idle', () => {
      expect(render({ dirty: false })).toBe('');
    });

    it('says "Unsaved changes" and enables the button when dirty', () => {
      const html = render({ dirty: true, label: 'Save role' });
      expect(html).toContain('Unsaved changes');
      expect(html).toMatch(/<button[^>]*>Save role</);
      expect(html).not.toMatch(/<button[^>]* disabled=""/);
    });

    it('stays visible to acknowledge a save once clean, with the button disabled', () => {
      const html = render({ dirty: false, saved: true });
      expect(html).toContain('Saved');
      expect(html).not.toContain('Unsaved changes');
      expect(html).toMatch(/<button[^>]* disabled=""/);
    });

    it('does not claim Saved while the form is dirty again', () => {
      const html = render({ dirty: true, saved: true, label: 'Save role' });
      expect(html).not.toContain('Saved ✓');
      expect(html).toContain('Save role');
    });

    it('stays visible when a clean form has an error to show', () => {
      expect(render({ dirty: false, error: 'Failed to delete role' })).toContain('Failed to delete role');
    });
  });
});
