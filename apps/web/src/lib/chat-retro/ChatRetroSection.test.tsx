import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DogfoodActivationRow } from './ChatRetroSection';

describe('DogfoodActivationRow', () => {
  it('renders the copy and the Turn on button', () => {
    const html = renderToStaticMarkup(<DogfoodActivationRow onActivate={() => {}} />);
    expect(html).toContain('Keep on for every team I own');
    expect(html).toContain('>Turn on<');
  });

  it('keeps the Turn on tap target 44px tall on mobile, 32px on desktop', () => {
    const html = renderToStaticMarkup(<DogfoodActivationRow onActivate={() => {}} />);
    const button = html.match(/<button[^>]*>Turn on<\/button>/)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('md:h-8');
  });
});
