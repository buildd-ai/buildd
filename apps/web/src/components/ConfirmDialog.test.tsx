import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConfirmDialog, { confirmInitialFocus } from './ConfirmDialog';

function render(variant: 'danger' | 'warning' | 'default') {
  return renderToStaticMarkup(
    <ConfirmDialog
      open
      title="Delete thing"
      message="This cannot be undone."
      confirmLabel="Delete"
      variant={variant}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe('ConfirmDialog', () => {
  it('is a labelled, modal dialog', () => {
    const html = render('danger');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain(`id="${describedBy}"`);
  });

  it('puts initial focus on Cancel for destructive variants, so a stray Enter does not confirm', () => {
    expect(confirmInitialFocus('danger')).toBe('cancel');
    expect(confirmInitialFocus('warning')).toBe('cancel');
    expect(confirmInitialFocus('default')).toBe('confirm');
  });

  it('does not use a status color as the destructive button background', () => {
    for (const variant of ['danger', 'warning'] as const) {
      const html = render(variant);
      const confirmButton = html.match(/<button[^>]*>Delete<\/button>/)?.[0] ?? '';
      expect(confirmButton).not.toBe('');
      expect(confirmButton).not.toMatch(/\bbg-status-/);
    }
  });
});
