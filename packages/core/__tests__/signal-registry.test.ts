import { describe, it, expect } from 'bun:test';
import {
  SIGNAL_REGISTRY,
  SIGNAL_FIRE_MARKER_PREFIX,
  formatSignalFireMarker,
  parseSignalFireMarkers,
} from '../signal-registry';

describe('signal-fire marker round trip', () => {
  const SLUGS = [
    'cbm-fleet-health',
    'claim-loop-stranding',
    'model-capability-validation',
    'a',
    'signal-with-many-hyphens-123',
  ];

  it.each(SLUGS)('formatting then parsing %s returns exactly that slug', slug => {
    const marker = formatSignalFireMarker(slug);
    expect(parseSignalFireMarkers(marker)).toEqual([slug]);
  });

  it('parses a marker embedded in a real comment line, not just in isolation', () => {
    const line = `  // ${formatSignalFireMarker('cbm-fleet-health')}`;
    expect(parseSignalFireMarkers(line)).toEqual(['cbm-fleet-health']);
  });

  it('parses every marker in a multi-line source, in order', () => {
    const source = [
      `// ${formatSignalFireMarker('one')}`,
      "it('does nothing', () => {});",
      `// ${formatSignalFireMarker('two')}`,
    ].join('\n');
    expect(parseSignalFireMarkers(source)).toEqual(['one', 'two']);
  });

  it('finds nothing in source with no marker', () => {
    expect(parseSignalFireMarkers('// just a normal comment\nit("x", () => {});')).toEqual([]);
  });

  it('the marker prefix is a stable, greppable shape — starts with @, ends with :, no whitespace', () => {
    // Not asserted against a respelled copy of the literal: doing so here
    // would put the exact marker text in a test file's raw source, which is
    // itself scanned by scripts/signal-fire-coverage.test.ts — see that
    // file's own header comment for why that self-matches.
    expect(SIGNAL_FIRE_MARKER_PREFIX.startsWith('@')).toBe(true);
    expect(SIGNAL_FIRE_MARKER_PREFIX.endsWith(':')).toBe(true);
    expect(/\s/.test(SIGNAL_FIRE_MARKER_PREFIX)).toBe(false);
  });
});

describe('SIGNAL_REGISTRY shape', () => {
  it('has no duplicate slugs', () => {
    const slugs = SIGNAL_REGISTRY.map(e => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has at least the five signals the audit found', () => {
    expect(SIGNAL_REGISTRY.length).toBeGreaterThanOrEqual(5);
  });

  it.each(SIGNAL_REGISTRY.map(e => [e.slug, e] as const))(
    '%s declares exactly one of fireTest or noLocalFireTest',
    (_slug, entry) => {
      const hasFireTest = !!entry.fireTest;
      const hasNoLocalFireTest = !!entry.noLocalFireTest;
      expect(hasFireTest !== hasNoLocalFireTest).toBe(true);
    },
  );

  it.each(SIGNAL_REGISTRY.filter(e => e.fireTest).map(e => [e.slug, e] as const))(
    '%s fireTest names a non-empty file and title',
    (_slug, entry) => {
      expect(entry.fireTest!.file.length).toBeGreaterThan(0);
      expect(entry.fireTest!.title.length).toBeGreaterThan(0);
    },
  );

  it.each(SIGNAL_REGISTRY.filter(e => e.noLocalFireTest).map(e => [e.slug, e] as const))(
    '%s noLocalFireTest names a non-empty reason and trackedBy',
    (_slug, entry) => {
      expect(entry.noLocalFireTest!.reason.length).toBeGreaterThan(0);
      expect(entry.noLocalFireTest!.trackedBy.length).toBeGreaterThan(0);
    },
  );

  it('every entry has a non-empty threshold justification', () => {
    for (const entry of SIGNAL_REGISTRY) {
      expect(entry.threshold.length).toBeGreaterThan(20);
    }
  });
});
