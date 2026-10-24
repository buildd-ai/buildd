import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: UiIdleAlert } = await import('./UiIdleAlert');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('UiIdleAlert', () => {
  it('renders idle alert with idle slots and queued tasks', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={4}
          queuedTasks={3}
          cause="no reviewer runner"
          href="#queue"
        />
      )
    );

    expect(container.textContent).toContain('4 idle');
    expect(container.textContent).toContain('3 queued');
    expect(container.textContent).toContain('no reviewer runner');
  });

  it('renders as a link with correct href', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={4}
          queuedTasks={3}
          cause="no reviewer runner"
          href="/queue"
        />
      )
    );

    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/queue');
  });

  it('uses default href of # when not provided', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={4}
          queuedTasks={3}
          cause="no reviewer runner"
        />
      )
    );

    const link = container.querySelector('a');
    expect(link!.getAttribute('href')).toBe('#');
  });

  it('renders nothing when idleSlots is 0 or negative', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={0}
          queuedTasks={3}
          cause="no reviewer runner"
        />
      )
    );

    expect(container.querySelector('a')).toBeNull();
  });

  it('displays an exclamation mark icon', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={4}
          queuedTasks={3}
          cause="no reviewer runner"
        />
      )
    );

    const textContent = container.textContent;
    expect(textContent).toContain('!');
  });

  it('displays a right chevron at the end', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={4}
          queuedTasks={3}
          cause="no reviewer runner"
        />
      )
    );

    const textContent = container.textContent;
    expect(textContent).toContain('›');
  });

  it('renders with warning color styling', () => {
    act(() =>
      root.render(
        <UiIdleAlert
          idleSlots={4}
          queuedTasks={3}
          cause="no reviewer runner"
        />
      )
    );

    const link = container.querySelector('a');
    const style = link!.getAttribute('style');

    expect(style).toContain('background: #FBF1E8');
    expect(style).toContain('color: #7F3C11');
  });
});
