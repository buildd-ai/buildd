import { describe, expect, it } from 'bun:test';
import { createConfirmController, type ConfirmOptions } from './useConfirm';

function setup() {
  const shown: (ConfirmOptions | null)[] = [];
  const controller = createConfirmController(o => shown.push(o));
  return { controller, shown };
}

describe('createConfirmController', () => {
  it('opens the dialog and resolves true on confirm, then closes it', async () => {
    const { controller, shown } = setup();
    const p = controller.open({ title: 'Delete?', message: 'x', variant: 'danger' });
    expect(shown.at(-1)?.title).toBe('Delete?');
    controller.settle(true);
    expect(await p).toBe(true);
    expect(shown.at(-1)).toBeNull();
  });

  it('resolves false on cancel', async () => {
    const { controller } = setup();
    const p = controller.open({ title: 't', message: 'm' });
    controller.settle(false);
    expect(await p).toBe(false);
  });

  it('a second request cancels an unanswered first one', async () => {
    const { controller } = setup();
    const first = controller.open({ title: 'a', message: 'm' });
    const second = controller.open({ title: 'b', message: 'm' });
    expect(await first).toBe(false);
    controller.settle(true);
    expect(await second).toBe(true);
  });

  it('settling with nothing pending is harmless', () => {
    const { controller } = setup();
    expect(() => controller.settle(true)).not.toThrow();
  });
});
