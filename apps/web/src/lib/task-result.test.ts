/**
 * A task result read for people (docs/specs/task-page.md AC-7): prose and a
 * verdict, never serialized JSON. The raw payload is kept for the Raw output
 * disclosure only.
 */
import { describe, expect, test } from 'bun:test';
import { readableTaskResult, REVIEW_VERDICT_LABEL } from './task-result';

// The payload from the reviewer run's screenshot: the summary arrived as a JSON string.
const SCREENSHOT = JSON.stringify({
  summary: 'The change lands both PRs and unblocks recovery.\n\nTests cover the stale escalation and the refresh hold.',
  verdict: 'approve',
  confidence: 0.8,
});

describe('readableTaskResult', () => {
  test('the screenshot payload: a JSON summary string reads as its prose and verdict', () => {
    const r = readableTaskResult(SCREENSHOT, null);
    expect(r.prose).toBe('The change lands both PRs and unblocks recovery.\n\nTests cover the stale escalation and the refresh hold.');
    expect(r.verdict).toBe('approve');
    expect(r.prose).not.toContain('{');
    expect(r.prose).not.toContain('confidence');
    expect(r.raw).toEqual({ summary: expect.any(String), verdict: 'approve', confidence: 0.8 });
    expect(r.malformed).toBe(false);
  });

  test('a structuredOutput object with the same fields reads the same', () => {
    const r = readableTaskResult(null, { summary: 'Looks right.', verdict: 'approve', confidence: 0.8 });
    expect(r.prose).toBe('Looks right.');
    expect(r.verdict).toBe('approve');
    expect(r.raw).toEqual({ summary: 'Looks right.', verdict: 'approve', confidence: 0.8 });
  });

  test('plain prose summary with a structured verdict: prose kept, verdict read', () => {
    const r = readableTaskResult('Two findings, both addressed.', { verdict: 'request_changes', confidence: 0.6 });
    expect(r.prose).toBe('Two findings, both addressed.');
    expect(r.verdict).toBe('request-changes');
  });

  test('a fenced JSON block is read like bare JSON', () => {
    const r = readableTaskResult('```json\n{"summary":"Fine.","verdict":"escalated"}\n```', null);
    expect(r.prose).toBe('Fine.');
    expect(r.verdict).toBe('escalate');
  });

  test('malformed JSON falls back to the text itself, flagged', () => {
    const text = '{"summary": "cut off mid';
    const r = readableTaskResult(text, null);
    expect(r.prose).toBe(text);
    expect(r.malformed).toBe(true);
    expect(r.verdict).toBeNull();
  });

  test('JSON with no prose field: no prose, the payload only as raw', () => {
    const r = readableTaskResult('{"verdict":"approve","confidence":0.9}', null);
    expect(r.prose).toBeNull();
    expect(r.verdict).toBe('approve');
    expect(r.raw).toEqual({ verdict: 'approve', confidence: 0.9 });
  });

  test('plain text is prose; empty is nothing', () => {
    expect(readableTaskResult('Shipped the header.', null)).toEqual({ prose: 'Shipped the header.', verdict: null, raw: null, malformed: false });
    expect(readableTaskResult('   ', undefined)).toEqual({ prose: null, verdict: null, raw: null, malformed: false });
  });

  test('an unknown verdict word is not invented into one', () => {
    expect(readableTaskResult(null, { verdict: 'lgtm' }).verdict).toBeNull();
  });

  test('verdict labels are the page vocabulary', () => {
    expect(REVIEW_VERDICT_LABEL.approve).toBe('Review approved');
    expect(REVIEW_VERDICT_LABEL['request-changes']).toBe('Changes requested');
    expect(REVIEW_VERDICT_LABEL.escalate).toBe('Escalated to a person');
  });
});
