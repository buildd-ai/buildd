import { expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
const { default: FeaturesSettingsPage } = await import('./page');

it('redirects retired Features bookmarks to estimate health', () => {
  expect(() => FeaturesSettingsPage()).toThrow('redirect:/app/health/estimates');
});
