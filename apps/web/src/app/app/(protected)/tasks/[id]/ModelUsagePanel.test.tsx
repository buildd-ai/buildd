import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelUsagePanel from './ModelUsagePanel';

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0.01,
});

describe('ModelUsagePanel', () => {
  test('humanises model ids instead of stripping the prefix by hand', () => {
    const html = renderToStaticMarkup(
      <ModelUsagePanel modelUsage={{ 'claude-sonnet-4-5-20250929': usage(1000, 200) }} />,
    );
    expect(html).toContain('Sonnet 4.5');
    expect(html).not.toContain('sonnet-4-5');
  });

  test('prefixes the section with the resolved tier', () => {
    const html = renderToStaticMarkup(
      <ModelUsagePanel modelUsage={{ 'claude-opus-5': usage(1000, 200) }} tierLabel="Premium" />,
    );
    expect(html).toContain('Premium');
    expect(html).toContain('Model Usage');
    expect(html.indexOf('Premium')).toBeLessThan(html.indexOf('Model Usage'));
  });

  test('omits the tier when the task has none', () => {
    const html = renderToStaticMarkup(<ModelUsagePanel modelUsage={{ 'claude-opus-5': usage(1, 1) }} />);
    expect(html).toContain('Model Usage');
  });

  test('makes it visible that more than one model ran', () => {
    const html = renderToStaticMarkup(
      <ModelUsagePanel
        modelUsage={{
          'claude-opus-5': usage(5000, 900),
          'claude-haiku-4-5': usage(10, 2),
        }}
        tierLabel="Premium"
      />,
    );
    expect(html).toContain('Opus 5');
    expect(html).toContain('Haiku 4.5');
    // Not implied to be a single model: the count is stated.
    expect(html).toContain('2 models');
  });

  test('says nothing about a count when only one model ran', () => {
    const html = renderToStaticMarkup(<ModelUsagePanel modelUsage={{ 'claude-opus-5': usage(1, 1) }} />);
    expect(html).not.toContain('1 model');
    expect(html).not.toContain('2 models');
  });

  test('renders nothing when the SDK attributed nothing (seat/OAuth auth)', () => {
    expect(renderToStaticMarkup(<ModelUsagePanel modelUsage={{}} tierLabel="Premium" />)).toBe('');
    expect(renderToStaticMarkup(<ModelUsagePanel modelUsage={null} />)).toBe('');
  });

  test('keeps the duration and stop-reason footer', () => {
    const html = renderToStaticMarkup(
      <ModelUsagePanel
        modelUsage={{ 'claude-opus-5': usage(1000, 200) }}
        durationMs={12000}
        durationApiMs={9000}
        terminalReason="max_turns"
      />,
    );
    expect(html).toContain('Total: 12s');
    expect(html).toContain('API: 9s');
    expect(html).toContain('max turns');
  });
});
