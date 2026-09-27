import { describe, expect, it } from 'bun:test';
import { missionSummaryLine } from './mission-summary-line';

describe('missionSummaryLine', () => {
  it('skips a "prior attempts" preamble and its list to the first real sentence', () => {
    const d = [
      'Prior attempts and why they failed — read before starting:',
      '- A cron replay double-sent invoices: it had no idempotency key.',
      '- Raising the HTTP timeout hid the outage.',
      '',
      'Retry failed partner webhooks with backoff so an outage stops dropping invoices. Park anything still failing after 24 hours.',
    ].join('\n');
    expect(missionSummaryLine(d)).toBe('Retry failed partner webhooks with backoff so an outage stops dropping invoices.');
  });

  it('takes the first sentence of a plain description', () => {
    expect(missionSummaryLine('Let users save a search. Then notify them.')).toBe('Let users save a search.');
  });

  it('skips headings and strips markdown', () => {
    expect(missionSummaryLine('## Goal\n\nShip **saved searches** to `beta` users.')).toBe('Ship saved searches to beta users.');
  });

  it('prefers a labelled goal line when the description has one', () => {
    expect(missionSummaryLine('Context: the export is slow.\nGoal: cut export time under a minute.\n')).toBe('Cut export time under a minute.');
  });

  it('keeps a sentence that only happens to contain a colon', () => {
    expect(missionSummaryLine('Two things matter here: speed and cost.')).toBe('Two things matter here: speed and cost.');
  });

  it('does not cut on a dotted token', () => {
    expect(missionSummaryLine('Bump next.js to 16.3 across apps/web.')).toBe('Bump next.js to 16.3 across apps/web.');
  });

  it('returns null when there is nothing but a preamble, or nothing at all', () => {
    expect(missionSummaryLine('Read before starting:\n- one\n- two')).toBeNull();
    expect(missionSummaryLine(null)).toBeNull();
    expect(missionSummaryLine('   ')).toBeNull();
  });
});
