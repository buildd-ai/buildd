import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPicker, normalizeAlias, detectStalePin } from './ModelPicker';

// --- Pure function tests ---

describe('normalizeAlias', () => {
  it('maps legacy aliases to canonical tiers', () => {
    expect(normalizeAlias('opus')).toBe('premium');
    expect(normalizeAlias('sonnet')).toBe('standard');
    expect(normalizeAlias('haiku')).toBe('budget');
  });

  it('passes canonical tier values through unchanged', () => {
    expect(normalizeAlias('inherit')).toBe('inherit');
    expect(normalizeAlias('premium')).toBe('premium');
    expect(normalizeAlias('standard')).toBe('standard');
    expect(normalizeAlias('budget')).toBe('budget');
  });

  it('passes exact model IDs through unchanged', () => {
    expect(normalizeAlias('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeAlias('claude-fable-5')).toBe('claude-fable-5');
    expect(normalizeAlias('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('detectStalePin', () => {
  const liveModels = ['claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5-20251001'];

  it('returns false for canonical tier values', () => {
    expect(detectStalePin('inherit', liveModels)).toBe(false);
    expect(detectStalePin('premium', liveModels)).toBe(false);
    expect(detectStalePin('standard', liveModels)).toBe(false);
    expect(detectStalePin('budget', liveModels)).toBe(false);
  });

  it('returns false for legacy aliases (they normalize to tiers)', () => {
    expect(detectStalePin('opus', liveModels)).toBe(false);
    expect(detectStalePin('sonnet', liveModels)).toBe(false);
    expect(detectStalePin('haiku', liveModels)).toBe(false);
  });

  it('returns false for an exact pin found in the live list', () => {
    expect(detectStalePin('claude-sonnet-5', liveModels)).toBe(false);
    expect(detectStalePin('claude-fable-5', liveModels)).toBe(false);
  });

  it('returns true for an exact pin NOT found in the live list', () => {
    expect(detectStalePin('claude-sonnet-3-5', liveModels)).toBe(true);
    expect(detectStalePin('claude-old-model', liveModels)).toBe(true);
  });

  it('returns false when live list is empty (models not yet fetched)', () => {
    expect(detectStalePin('claude-old-model', [])).toBe(false);
  });

  it('returns false for any pin when the catalog is incomplete', () => {
    // /api/models returns the team's tier models even with no credential, so a
    // non-empty list is no longer proof the list is exhaustive. Warning off a
    // partial list would flag every legitimately pinned release as retired.
    expect(detectStalePin('claude-old-model', liveModels, false)).toBe(false);
    expect(detectStalePin('claude-sonnet-5', liveModels, false)).toBe(false);
  });

  it('still warns on a genuinely retired pin when the catalog is complete', () => {
    expect(detectStalePin('claude-old-model', liveModels, true)).toBe(true);
  });
});

// --- SSR component tests ---

describe('ModelPicker (SSR)', () => {
  const noop = () => {};

  it('renders all four tier buttons', () => {
    const html = renderToStaticMarkup(<ModelPicker value="inherit" onChange={noop} />);
    expect(html).toContain('Inherit');
    expect(html).toContain('Premium');
    expect(html).toContain('Standard');
    expect(html).toContain('Budget');
  });

  it('marks the correct tier button as selected via data-selected', () => {
    const html = renderToStaticMarkup(<ModelPicker value="premium" onChange={noop} />);
    // Premium should be selected
    expect(html).toContain('"premium"');
    // Verify via data-testid + data-selected pattern
    const premiumSelected = html.match(/data-selected="true"[^>]*>Premium/) ||
      html.match(/Premium[^<]*<\/button>/) && html.includes('data-selected="true"');
    expect(html).toContain('data-tier="premium" data-selected="true"');
  });

  it('maps legacy alias "opus" to premium tier for display', () => {
    const html = renderToStaticMarkup(<ModelPicker value="opus" onChange={noop} />);
    // normalized = 'premium', so premium button should be selected
    expect(html).toContain('data-tier="premium" data-selected="true"');
    expect(html).not.toContain('data-tier="standard" data-selected="true"');
  });

  it('maps legacy alias "sonnet" to standard tier for display', () => {
    const html = renderToStaticMarkup(<ModelPicker value="sonnet" onChange={noop} />);
    expect(html).toContain('data-tier="standard" data-selected="true"');
  });

  it('maps legacy alias "haiku" to budget tier for display', () => {
    const html = renderToStaticMarkup(<ModelPicker value="haiku" onChange={noop} />);
    expect(html).toContain('data-tier="budget" data-selected="true"');
  });

  it('shows no tier selected when value is an exact model pin', () => {
    const html = renderToStaticMarkup(<ModelPicker value="claude-sonnet-5" onChange={noop} />);
    expect(html).not.toContain('data-tier="inherit" data-selected="true"');
    expect(html).not.toContain('data-tier="premium" data-selected="true"');
    expect(html).not.toContain('data-tier="standard" data-selected="true"');
    expect(html).not.toContain('data-tier="budget" data-selected="true"');
  });

  it('shows pinned model ID display when value is an exact pin', () => {
    const html = renderToStaticMarkup(<ModelPicker value="claude-sonnet-5" onChange={noop} />);
    expect(html).toContain('claude-sonnet-5');
  });

  it('does NOT show stale-pin badge on initial render (models not fetched)', () => {
    const html = renderToStaticMarkup(<ModelPicker value="claude-old-model-xyz" onChange={noop} />);
    expect(html).not.toContain('data-testid="stale-pin-badge"');
  });

  it('does not show advanced panel by default', () => {
    const html = renderToStaticMarkup(<ModelPicker value="inherit" onChange={noop} />);
    expect(html).not.toContain('data-testid="advanced-panel"');
  });

  it('renders Pin exact model toggle button', () => {
    const html = renderToStaticMarkup(<ModelPicker value="inherit" onChange={noop} />);
    expect(html).toContain('Pin exact model');
  });

  it('is disabled when disabled prop is true', () => {
    const html = renderToStaticMarkup(<ModelPicker value="premium" onChange={noop} disabled />);
    // All tier buttons should be disabled
    const disabledCount = (html.match(/disabled=""/g) || []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(4);
  });
});
