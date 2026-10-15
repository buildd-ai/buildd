import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });
import { afterEach, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownContent from './MarkdownContent';
import { requirementIds } from '@buildd/spec-contract/requirements';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
const render = (content: string, surface: 'spec' | 'default' = 'spec') => act(() => root.render(<MarkdownContent content={content} surface={surface} />));
const rows = () => [...container.querySelectorAll('[data-testid="spec-criterion"]')];

it('separates consecutive plain definitions, preserving surrounding prose and inline Markdown', () => {
  render('Intro with *emphasis*.\nR-11: **First** requirement.\nAC-3: [Second](https://example.test) requirement.\nFollowing prose.');
  expect(rows().map(r => r.id)).toEqual(['R-11', 'AC-3']);
  expect(rows()[0].querySelector('a[href="#R-11"] .font-mono')?.textContent).toBe('R-11');
  expect(rows()[0].querySelector('strong')?.textContent).toBe('First');
  expect(rows()[1].querySelector('a[href="https://example.test"]')).not.toBeNull();
  expect(container.querySelector('em')?.textContent).toBe('emphasis');
  expect(container.textContent).toContain('Following prose.');
  expect(rows()[0].parentElement).toBe(rows()[1].parentElement);
  expect(rows()[1].className).toContain('border');
  expect(container.querySelector('p div')).toBeNull();
});

it('uses exactly the shared parser definitions for lists, headings, tables, duplicates and fenced examples', () => {
  const body = '- **R-01**: List **text**\n- __AC-2__: Acceptance\n\n### D-3 Decision\nI-4: Invariant\n\n| Id | Rule | Check |\n|---|---|---|\n| **R-5** | Table *text* | `unit` |\n| other | ordinary row | keep |\n\nR-1: duplicate\n\n```\nR-6: example\n```';
  render(body);
  expect(rows().map(r => r.id)).toEqual(requirementIds(body).map(r => r.id));
  expect(container.querySelectorAll('#R-1')).toHaveLength(1);
  expect(container.querySelector('#R-5 em')?.textContent).toBe('text');
  expect(container.querySelector('#R-5 code')?.textContent).toBe('unit');
  expect(container.querySelector('table')?.textContent).toContain('ordinary row');
  expect(container.querySelector('pre')?.textContent).toContain('R-6: example');
  expect(container.textContent).toContain('duplicate');
});

it('keeps ordinary Markdown and other surfaces unchanged', () => {
  render('# Overview\n\n- ordinary item\n\n> quoted\n\n| A | B |\n|---|---|\n| one | two |');
  expect(rows()).toHaveLength(0);
  expect(container.querySelector('h1')?.textContent).toBe('Overview');
  expect(container.querySelector('li')?.textContent).toBe('ordinary item');
  expect(container.querySelector('blockquote')).not.toBeNull();
  expect(container.querySelector('table')).not.toBeNull();
  render('R-1: First\nAC-2: Second', 'default');
  expect(rows()).toHaveLength(0);
  expect(container.querySelectorAll('p')).toHaveLength(1);
});

it('renders parser-recognized pipe rows even without a Markdown table header', () => {
  render('| R-7 | A bare row | check |\n| AC-8 | Another row | check |');
  expect(rows().map(r => r.id)).toEqual(['R-7', 'AC-8']);
  expect(rows()[0].textContent).toBe('R-7A bare row; check');
});

it('keeps ordinary list items around criteria and renders numbered definitions', () => {
  render('1. Before\n2. R-9: Numbered criterion\n3. After');
  expect(rows().map(r => r.id)).toEqual(['R-9']);
  expect([...container.querySelectorAll('li')].map(n => n.textContent)).toEqual(['Before', 'After']);
  expect(container.querySelectorAll('ol')[1]?.getAttribute('start')).toBe('3');
});

it('renders a definition in the first row of a valid GFM table', () => {
  render('| R-10 | A header definition |\n|---|---|\n| AC-11 | A body definition |');
  expect(rows().map(r => r.id)).toEqual(['R-10', 'AC-11']);
});

it('renders indented definition lines counted by the shared parser, retaining surrounding code', () => {
  const body = '    const before = 1;\n    R-14: Indented definition\n    AC-15: Another definition\n    const after = 2;';
  render(body);
  expect(rows().map(r => r.id)).toEqual(requirementIds(body).map(r => r.id));
  expect([...container.querySelectorAll('pre')].map(n => n.textContent?.trim())).toEqual(['const before = 1;', 'const after = 2;']);
});


it('keeps parser definitions visible inside otherwise hidden Markdown wrappers', () => {
  const body = '<section>\nR-16: Wrapped definition\n</section>\n\n[^unused]: Note\n    AC-17: Footnote definition';
  render(body);
  expect(rows().map(r => r.id)).toEqual(requirementIds(body).map(r => r.id));
});
