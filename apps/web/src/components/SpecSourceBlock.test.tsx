import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpecSourceBlock } from './SpecSourceBlock';

describe('SpecSourceBlock', () => {
  it('renders the spec path and a link to the planning task when specSource is present', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specPath: 'docs/design/spec-to-build-pattern.md', planningTaskId: 'task-123' }} />
    );
    expect(html).toContain('docs/design/spec-to-build-pattern.md');
    expect(html).toContain('/app/tasks/task-123');
    expect(html).toContain('Planning task');
  });

  it('renders nothing when specSource is absent', () => {
    expect(renderToStaticMarkup(<SpecSourceBlock specSource={null} />)).toBe('');
    expect(renderToStaticMarkup(<SpecSourceBlock specSource={undefined} />)).toBe('');
  });

  it('renders nothing when specSource is missing required fields', () => {
    expect(
      renderToStaticMarkup(<SpecSourceBlock specSource={{ specPath: '', planningTaskId: 'task-123' }} />)
    ).toBe('');
    expect(
      renderToStaticMarkup(
        // A repo document without its planning task is not shown on its own.
        <SpecSourceBlock specSource={{ specPath: 'docs/design/spec-to-build-pattern.md' }} />
      )
    ).toBe('');
  });

  it('shows the Living Spec revision a task is pinned to, with its short hash', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 3, contentHash: 'abcdef0123456789' }} />
    );
    expect(html).toContain('Pinned to revision 3');
    expect(html).toContain('abcdef012345');
    expect(html).not.toContain('Planning task');
  });
});
