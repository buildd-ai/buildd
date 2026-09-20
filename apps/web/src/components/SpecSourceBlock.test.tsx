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
        // @ts-expect-error — deliberately missing planningTaskId to prove the guard holds
        <SpecSourceBlock specSource={{ specPath: 'docs/design/spec-to-build-pattern.md' }} />
      )
    ).toBe('');
  });
});
