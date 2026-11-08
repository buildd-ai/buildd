import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelComparisonView from './ModelComparisonView';
import { resolveComparisonQaData } from './qa-state';

describe('resolveComparisonQaData', () => {
  it('returns data on the dev server only, for state=populated only', () => {
    expect(resolveComparisonQaData('populated', 'development')).not.toBeNull();
    expect(resolveComparisonQaData(['populated'], 'development')).not.toBeNull();
    expect(resolveComparisonQaData('populated', 'production')).toBeNull();
    expect(resolveComparisonQaData('populated', 'test')).toBeNull();
    expect(resolveComparisonQaData('other', 'development')).toBeNull();
    expect(resolveComparisonQaData(undefined, 'development')).toBeNull();
  });

  it('renders attempts, pairs, tool use and evidence gaps', () => {
    const data = resolveComparisonQaData('populated', 'development')!;
    const html = renderToStaticMarkup(<ModelComparisonView data={data} />);
    expect(html).not.toContain('No attempts match these filters.');
    expect(html).toContain('model-a');
    expect(html).toContain('model-b');
    expect(html).toContain('Measured:');
    expect(html).toContain('Tool use not recorded');
    expect(html).toContain('not recorded for');
    expect(data.matched.pairs.length).toBeGreaterThan(0);
  });
});
