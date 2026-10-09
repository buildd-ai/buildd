import { expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
const { default: NewTaskPage } = await import('./page');

const WS = '11111111-1111-4111-8111-111111111111';

it('the retired new-task form sends old links to a new task chat', async () => {
  await expect(NewTaskPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /app/chat?new=task');
});

it('keeps the workspace the old link named', async () => {
  await expect(NewTaskPage({ searchParams: Promise.resolve({ workspaceId: WS, title: 'x' }) })).rejects.toThrow(`REDIRECT /app/chat?new=task&ws=${WS}`);
});
