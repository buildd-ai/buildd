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
    // Ink, not orange: orange is never a selected state.
    expect(button).toContain('border-text-primary');
  });

  it('is not current elsewhere', () => {
    const html = renderToStaticMarkup(<UserAvatarMenu userInitial="A" direction="down" />);
    expect(html).not.toContain('aria-current');
  });
});

// The theme toggle left the rail and the phone Home header for this menu.
describe('UserAvatarMenu theme', () => {
  it('the menu carries the theme switch', async () => {
    const { default: Menu } = await import('./UserAvatarMenu');
    const { menuItems } = await import('./UserAvatarMenu');
    expect(Menu).toBeDefined();
    expect(menuItems.map(i => i.id)).toEqual(['account', 'settings', 'theme', 'sign-out']);
  });
});
