import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskModelCell from './TaskModelCell';
import { deriveTaskModel } from '@/lib/model-presentation';

const render = (input: Parameters<typeof deriveTaskModel>[0]) =>
  renderToStaticMarkup(<TaskModelCell summary={deriveTaskModel(input)} />);

describe('TaskModelCell', () => {
  test('leads with the tier and keeps the concrete id in mono beneath it', () => {
    const html = render({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'workspace' } },
    });
    expect(html).toContain('Model');
    expect(html).toContain('Premium');
    expect(html).toContain('claude-opus-5');
    expect(html).toContain('font-mono');
    expect(html).toContain('text-[11px]');
    // Tier first: it is the primary label, the id is secondary detail.
    expect(html.indexOf('Premium')).toBeLessThan(html.indexOf('claude-opus-5'));
  });

  test('answers "why this model" by naming the resolution source', () => {
    expect(render({
      tier: 'standard',
      predictedModel: 'claude-sonnet-5',
      context: { resolvedTier: { tier: 'standard', provider: 'anthropic', source: 'team' } },
    })).toContain('team');
  });

  test('renders the pinned state when the claim route recorded an override', () => {
    const html = render({
      predictedModel: 'claude-sonnet-4-6',
      context: { model: 'claude-sonnet-4-6', routingReason: 'explicit_override' },
    });
    expect(html).toContain('Pinned');
    expect(html).toContain('claude-sonnet-4-6');
  });

  test('does not claim a pin when no reason was recorded', () => {
    // Tasks claimed before `routingReason` shipped carry a concrete model and no
    // resolvedTier — indistinguishable from a real pin. Saying "Pinned" there
    // would attribute a decision nobody made.
    const html = render({
      tier: 'standard',
      predictedModel: 'claude-sonnet-4-6',
      context: { model: 'claude-sonnet-4-6' },
    });
    expect(html).not.toContain('Pinned');
    expect(html).toContain('Standard');
  });

  test('an unclaimed task renders the requested tier alone, not an empty row', () => {
    const html = render({ tier: 'budget' });
    expect(html).toContain('Budget');
    expect(html).not.toContain('font-mono');
  });

  test('renders nothing when nothing is known', () => {
    expect(render({})).toBe('');
  });

  test('marks divergence in muted text, never a warning colour', () => {
    const html = render({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'team' } },
      modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 20 } },
    });
    expect(html).toContain('Sonnet 5');
    expect(html).toContain('text-text-muted');
    // A fallback firing is normal; only the fleet aggregate is alarming.
    expect(html).not.toContain('status-warning');
    expect(html).not.toContain('status-error');
  });

  test('stays silent when the model that ran is the one assigned', () => {
    const html = render({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'team' } },
      modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20 } },
    });
    expect(html).not.toContain('Ran on');
  });

  test('stays silent when nothing was attributed', () => {
    const html = render({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'team' } },
      modelUsage: {},
    });
    expect(html).not.toContain('Ran on');
  });

  test('never hides the model id in a title attribute', () => {
    const html = render({
      tier: 'premium',
      predictedModel: 'claude-opus-5',
      context: { resolvedTier: { tier: 'premium', provider: 'anthropic', source: 'team' } },
    });
    expect(html).not.toContain('title=');
  });
});
