import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next-auth/react', () => ({ signOut: () => {} }));

const { default: UserAvatarMenu } = await import('./UserAvatarMenu');

describe('UserAvatarMenu', () => {
  it('the mobile header avatar is a 44px tap target', () => {
    const html = renderToStaticMarkup(<UserAvatarMenu userInitial="A" direction="down" />);
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('w-11');
    expect(button).toContain('h-11');
  });

  it('the desktop sidebar avatar keeps its compact 32px size', () => {
    const html = renderToStaticMarkup(<UserAvatarMenu userInitial="A" />);
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('w-8');
    expect(button).not.toContain('w-11');
  });
});

describe('UserAvatarMenu active state', () => {
  it('marks the avatar as the current page on account routes', () => {
    const html = renderToStaticMarkup(<UserAvatarMenu userInitial="A" direction="down" active />);
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-current="page"');
    expect(button).toContain('border-accent');
  });

  it('is not current elsewhere', () => {
    const html = renderToStaticMarkup(<UserAvatarMenu userInitial="A" direction="down" />);
    expect(html).not.toContain('aria-current');
  });
});
