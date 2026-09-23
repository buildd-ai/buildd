import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Dialog from './Dialog';
import { captureFocus, createBackdropDismiss, handleDialogKeyDown } from './dialog-focus';

function el(name: string) {
  return { name, focus: mock(() => {}) };
}

function panelOf(items: ReturnType<typeof el>[]) {
  const panel = {
    ...el('panel'),
    querySelectorAll: () => items,
    contains: (node: unknown) => node === panel || items.includes(node as ReturnType<typeof el>),
  };
  return panel;
}

function key(k: string, shiftKey = false) {
  return { key: k, shiftKey, preventDefault: mock(() => {}) };
}

describe('Dialog markup', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <Dialog open={false} onClose={() => {}} labelledBy="h">
        <h2 id="h">Title</h2>
      </Dialog>,
    );
    expect(html).toBe('');
  });

  it('renders role=dialog, aria-modal and the given aria-labelledby/aria-describedby', () => {
    const html = renderToStaticMarkup(
      <Dialog open onClose={() => {}} labelledBy="dlg-title" describedBy="dlg-body">
        <h2 id="dlg-title">Title</h2>
        <p id="dlg-body">Body</p>
      </Dialog>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="dlg-title"');
    expect(html).toContain('aria-describedby="dlg-body"');
  });

  it('accepts aria-label when there is no visible heading', () => {
    const html = renderToStaticMarkup(
      <Dialog open onClose={() => {}} label="Quick create">
        <p>Body</p>
      </Dialog>,
    );
    expect(html).toContain('aria-label="Quick create"');
  });
});

describe('handleDialogKeyDown', () => {
  it('Escape calls onClose when dismissible', () => {
    const onClose = mock(() => {});
    const e = key('Escape');
    handleDialogKeyDown(e, { panel: panelOf([]), activeElement: null, onClose, dismissible: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Escape does nothing while not dismissible (request in flight)', () => {
    const onClose = mock(() => {});
    handleDialogKeyDown(key('Escape'), { panel: panelOf([]), activeElement: null, onClose, dismissible: false });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Tab from the last focusable wraps to the first', () => {
    const [a, b, c] = [el('a'), el('b'), el('c')];
    const e = key('Tab');
    handleDialogKeyDown(e, { panel: panelOf([a, b, c]), activeElement: c, onClose: () => {}, dismissible: true });
    expect(a.focus).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Shift+Tab from the first focusable wraps to the last', () => {
    const [a, b, c] = [el('a'), el('b'), el('c')];
    const e = key('Tab', true);
    handleDialogKeyDown(e, { panel: panelOf([a, b, c]), activeElement: a, onClose: () => {}, dismissible: true });
    expect(c.focus).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Tab in the middle is left to the browser', () => {
    const [a, b, c] = [el('a'), el('b'), el('c')];
    const e = key('Tab');
    handleDialogKeyDown(e, { panel: panelOf([a, b, c]), activeElement: b, onClose: () => {}, dismissible: true });
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(a.focus).not.toHaveBeenCalled();
    expect(c.focus).not.toHaveBeenCalled();
  });

  it('Tab with focus outside the panel pulls it back to the first focusable', () => {
    const [a, b] = [el('a'), el('b')];
    const e = key('Tab');
    handleDialogKeyDown(e, { panel: panelOf([a, b]), activeElement: el('outside'), onClose: () => {}, dismissible: true });
    expect(a.focus).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Tab with no focusables keeps focus on the panel', () => {
    const panel = panelOf([]);
    const e = key('Tab');
    handleDialogKeyDown(e, { panel, activeElement: null, onClose: () => {}, dismissible: true });
    expect(panel.focus).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe('captureFocus', () => {
  it('restores focus to the element that was active when the dialog opened', () => {
    const opener = el('opener');
    const restore = captureFocus({ activeElement: opener });
    expect(opener.focus).not.toHaveBeenCalled();
    restore();
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing focusable was active', () => {
    const restore = captureFocus({ activeElement: null });
    expect(() => restore()).not.toThrow();
  });
});

describe('createBackdropDismiss', () => {
  const backdrop = { name: 'backdrop' };
  const inPanel = { name: 'panel-text' };
  const on = (target: unknown) => ({ target, currentTarget: backdrop });

  it('closes when the press starts and ends on the backdrop', () => {
    const d = createBackdropDismiss();
    d.onMouseDown(on(backdrop));
    expect(d.shouldClose(on(backdrop))).toBe(true);
  });

  it('does not close when a drag starts in the panel and ends on the backdrop (text selection)', () => {
    const d = createBackdropDismiss();
    d.onMouseDown(on(inPanel));
    expect(d.shouldClose(on(backdrop))).toBe(false);
  });

  it('does not close when the press starts on the backdrop and ends in the panel', () => {
    const d = createBackdropDismiss();
    d.onMouseDown(on(backdrop));
    expect(d.shouldClose(on(inPanel))).toBe(false);
  });

  it('does not close on a click with no preceding mousedown', () => {
    const d = createBackdropDismiss();
    expect(d.shouldClose(on(backdrop))).toBe(false);
  });

  it('forgets the mousedown after one click', () => {
    const d = createBackdropDismiss();
    d.onMouseDown(on(backdrop));
    d.shouldClose(on(backdrop));
    expect(d.shouldClose(on(backdrop))).toBe(false);
  });
});
