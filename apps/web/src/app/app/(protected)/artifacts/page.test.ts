import { expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
const { default: ArtifactsPage } = await import('./page');

it('the retired artifacts list sends old links to Missions', () => {
  expect(() => ArtifactsPage()).toThrow('REDIRECT /app/missions');
});
