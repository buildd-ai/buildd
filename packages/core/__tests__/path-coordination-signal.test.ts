/**
 * Sentinel semantics for path coordination (path-claim-ownership.md): history
 * truncation and normal blocked claims are never an outage; real
 * unavailability and an unproven ship checkpoint are.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/path-coordination-signal.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  classifyPathCoordinationEvent,
  summarizePathCoordination,
  PATH_SIGNAL_REASONS,
  SIGNAL_SEVERITY,
} from '../path-coordination-signal';
import { normalizeErrorSignature } from '../error-signature';

const ev = (over: { gate?: string; outcome?: string; reason: string; detail?: Record<string, unknown> | null }) => ({
  gate: 'path_claim', outcome: 'warned', ...over,
});

describe('classifyPathCoordinationEvent', () => {
  it('every writer reason classifies to its own signal after write-time normalization', () => {
    const norm = (s: string) => normalizeErrorSignature(s);
    expect(classifyPathCoordinationEvent(ev({ reason: norm(PATH_SIGNAL_REASONS.observation_truncated) }))).toBe('observation_truncated');
    expect(classifyPathCoordinationEvent(ev({ outcome: 'deferred', reason: norm(PATH_SIGNAL_REASONS.claim_blocked) }))).toBe('claim_blocked');
    expect(classifyPathCoordinationEvent(ev({ outcome: 'deferred', reason: norm(PATH_SIGNAL_REASONS.claim_blocked_checkpoint) }))).toBe('claim_blocked');
    expect(classifyPathCoordinationEvent(ev({ outcome: 'deferred', reason: norm(PATH_SIGNAL_REASONS.deadlock_detected) }))).toBe('deadlock_detected');
    expect(classifyPathCoordinationEvent(ev({ gate: 'path_declaration', reason: norm(PATH_SIGNAL_REASONS.coordination_unavailable) }))).toBe('coordination_unavailable');
    expect(classifyPathCoordinationEvent(ev({ outcome: 'deferred', reason: norm(PATH_SIGNAL_REASONS.coverage_unknown_refused) }))).toBe('coverage_unknown_at_ship');
    expect(classifyPathCoordinationEvent(ev({ reason: norm(PATH_SIGNAL_REASONS.coverage_unknown_advisory) }))).toBe('coverage_unknown_at_ship');
  });

  it('the legacy cap warning is history truncation, not degraded enforcement', () => {
    const legacy = normalizeErrorSignature(
      'observed touches past the 500-path cap were not recorded or leased: path-claim enforcement degraded',
    );
    expect(classifyPathCoordinationEvent(ev({ reason: legacy }))).toBe('observation_truncated');
  });

  it('a blocked claim with detail.deadlock is a deadlock, not a plain block', () => {
    expect(classifyPathCoordinationEvent(ev({
      outcome: 'deferred', reason: PATH_SIGNAL_REASONS.claim_blocked, detail: { deadlock: true },
    }))).toBe('deadlock_detected');
  });

  it('detail.signal wins over the text', () => {
    expect(classifyPathCoordinationEvent(ev({ reason: 'anything at all', detail: { signal: 'coverage_unknown_at_ship' } }))).toBe('coverage_unknown_at_ship');
    expect(classifyPathCoordinationEvent(ev({ reason: 'anything at all', detail: { signal: 'not-a-signal' } }))).toBeNull();
  });

  it('other gates and unclassifiable path rows are null', () => {
    expect(classifyPathCoordinationEvent(ev({ gate: 'merge_policy', reason: PATH_SIGNAL_REASONS.coordination_unavailable }))).toBeNull();
    expect(classifyPathCoordinationEvent(ev({ outcome: 'rejected', reason: 'wildcard claim' }))).toBeNull();
  });

  it('severities keep healthy contention below every real failure', () => {
    expect(SIGNAL_SEVERITY.claim_blocked).toBe('healthy');
    expect(SIGNAL_SEVERITY.observation_truncated).toBe('advisory');
    expect(SIGNAL_SEVERITY.coordination_unavailable).toBe('degraded');
    expect(SIGNAL_SEVERITY.coverage_unknown_at_ship).toBe('critical');
  });
});

describe('summarizePathCoordination', () => {
  it('thousands of truncation advisories and blocked claims are not an incident', () => {
    const events = [
      ...Array.from({ length: 2500 }, () => ev({ reason: PATH_SIGNAL_REASONS.observation_truncated })),
      ...Array.from({ length: 180 }, () => ev({ outcome: 'deferred', reason: PATH_SIGNAL_REASONS.claim_blocked })),
      ...Array.from({ length: 13 }, () => ev({ outcome: 'deferred', reason: PATH_SIGNAL_REASONS.deadlock_detected })),
    ];
    const s = summarizePathCoordination(events);
    expect(s.incident).toBe(false);
    expect(s.counts.observation_truncated).toBe(2500);
    expect(s.counts.claim_blocked).toBe(180);
    expect(s.counts.deadlock_detected).toBe(13);
    expect(s.severity).toBe('conflict');
    expect(s.verdict).toContain('available');
    expect(s.verdict).not.toContain('degraded');
  });

  it('one real unavailability or an unproven ship is an incident, and the healthy counts are named as not part of it', () => {
    const s = summarizePathCoordination([
      ev({ outcome: 'deferred', reason: PATH_SIGNAL_REASONS.claim_blocked }),
      ev({ gate: 'path_declaration', reason: PATH_SIGNAL_REASONS.coordination_unavailable }),
    ]);
    expect(s.incident).toBe(true);
    expect(s.severity).toBe('degraded');
    expect(s.verdict).toMatch(/degraded/);
    expect(s.verdict).toMatch(/Not part of the incident/);

    const refused = summarizePathCoordination([ev({ outcome: 'deferred', reason: PATH_SIGNAL_REASONS.coverage_unknown_refused })]);
    expect(refused.incident).toBe(true);
    expect(refused.severity).toBe('critical');
  });

  it('ignores non-path gates and counts unclassifiable path rows separately', () => {
    const s = summarizePathCoordination([
      ev({ gate: 'merge_policy', reason: 'whatever' }),
      ev({ outcome: 'rejected', reason: 'wildcard claim' }),
    ]);
    expect(s.unclassified).toBe(1);
    expect(s.severity).toBeNull();
    expect(s.incident).toBe(false);
  });
});
