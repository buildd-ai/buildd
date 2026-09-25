import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CriteriaGraderControl, normalizeCriteriaGrader } from './CriteriaGraderControl';

describe('CriteriaGraderControl', () => {
  it('renders the three options and the helper copy', () => {
    const html = renderToStaticMarkup(<CriteriaGraderControl value="auto" onChange={() => {}} />);
    expect(html).toContain('Criteria grading');
    for (const label of ['>Auto<', '>API key<', '>Runner<']) expect(html).toContain(label);
    expect(html).toContain('Auto uses your API key when one is set, otherwise a runner on your team&#x27;s seat.');
  });

  it('marks exactly the selected option checked', () => {
    const html = renderToStaticMarkup(<CriteriaGraderControl value="runner" onChange={() => {}} />);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true"[^>]*>Runner</);
  });

  it('keeps tap targets at least 44px tall', () => {
    const html = renderToStaticMarkup(<CriteriaGraderControl value="auto" onChange={() => {}} />);
    const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    for (const r of radios) expect(r).toContain('min-h-11');
  });
});

describe('normalizeCriteriaGrader', () => {
  it('treats missing and unknown values as auto', () => {
    expect(normalizeCriteriaGrader(undefined)).toBe('auto');
    expect(normalizeCriteriaGrader(null)).toBe('auto');
    expect(normalizeCriteriaGrader('llm')).toBe('auto');
    expect(normalizeCriteriaGrader('api')).toBe('api');
    expect(normalizeCriteriaGrader('runner')).toBe('runner');
  });
});
