import { expect, it } from 'bun:test';
import { extractChangedSubjects } from './pipeline';
import { staticCopyContexts } from './static-context';

const file = 'apps/web/src/components/Example.tsx';
const contextFor = (content: string, text = 'Target') => {
  const subjects = extractChangedSubjects({ file, before: '', after: content });
  const subject = subjects.find(s => s.after === text)!;
  return staticCopyContexts(file, content, subjects).get(subject.start);
};

it('reads a local neighboring heading and static sentence, changing with that heading', () => {
  const markup = '<section><h2>Models</h2><p>Manage providers.</p><button>Target</button></section>';
  expect(contextFor(markup)).toEqual({ container: 'section', heading: 'Models', nearbyText: ['Manage providers.'], completeness: 'static-partial' });
  expect(contextFor(markup.replace('Models', 'Agents'))?.heading).toBe('Agents');
});

it('does not cross the nearest native container into other cards', () => {
  const content = '<main><h1>Private outer title</h1><section><h2>Other card</h2><p>Private other copy</p></section><section><h2>Local card</h2><button>Target</button></section></main>';
  expect(contextFor(content)).toEqual({ container: 'section', heading: 'Local card', nearbyText: [], completeness: 'static-partial' });
});

it('omits custom, dynamic, hidden and executable content rather than inventing its text', () => {
  const content = 'const codeOnly="private code"; const el=<section><h2>Local</h2><Widget>private component</Widget><p>{privateDynamic}</p><p>Do {verb} delete</p><p hidden>private hidden</p><p aria-hidden="true">private aria</p><p className="hidden">private css</p><script>{"private script"}</script><style>{"private style"}</style><button title="Target">Target</button></section>';
  const context = contextFor(content);
  expect(context).toEqual({ container: 'section', heading: 'Local', nearbyText: [], completeness: 'static-partial' });
  expect(JSON.stringify(context)).not.toContain('private');
});

it('preserves complete static inline sentences and selects only two closest siblings', () => {
  const content = '<section><p>Far away</p><p>Do <strong>not</strong> delete.</p><p>{"Requires approval."}</p><button>Target</button></section>';
  expect(contextFor(content)?.nearbyText).toEqual(['Do not delete.', 'Requires approval.']);
});

it('omits oversized text instead of truncating its meaning', () => {
  const content = `<section><h2>${'h'.repeat(121)}</h2><p>${'a'.repeat(161)}</p><p>Fits</p><button>Target</button></section>`;
  expect(contextFor(content)).toEqual({ container: 'section', nearbyText: ['Fits'], completeness: 'static-partial' });
  expect(contextFor(`<section><h2>Old heading</h2><h2>${'h'.repeat(121)}</h2><button>Target</button></section>`)?.heading).toBeUndefined();
  expect(contextFor('<section><h2>Old heading</h2><h2>{dynamicHeading}</h2><button>Target</button></section>')?.heading).toBeUndefined();
});

it('omits hidden/custom scopes, custom elements and invalid source without a visibility claim', () => {
  expect(contextFor('<section hidden><h2>Private</h2><button>Target</button></section>')).toBeUndefined();
  expect(contextFor('<Panel><section><h2>Private</h2><button>Target</button></section></Panel>')).toBeUndefined();
  expect(contextFor('<section><my-widget>Private</my-widget><button>Target</button></section>')?.nearbyText).toEqual([]);
  expect(staticCopyContexts(file, '<section title=', [])).toEqual(new Map());
});

it('uses source spans to associate each subject and never includes attribute values as neighbors', () => {
  const content = '<section title="private attribute"><h2>Local</h2><button>Target</button><p title="private title">Visible text</p></section>';
  const subjects = extractChangedSubjects({ file, before: '', after: content });
  const target = subjects.find(s => s.after === 'Target')!;
  const context = staticCopyContexts(file, content, subjects).get(target.start);
  expect(context?.nearbyText).toEqual(['Visible text']);
  expect(JSON.stringify(context)).not.toContain('private');
});
