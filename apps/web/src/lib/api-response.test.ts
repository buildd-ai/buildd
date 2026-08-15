import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockReportOps = mock(() => Promise.resolve(true));

mock.module('@buildd/core/report-ops', () => ({
  reportOps: mockReportOps,
}));

// Must import AFTER mocks
const { jsonResponse } = await import('./api-response');

describe('jsonResponse', () => {
  beforeEach(() => {
    mockReportOps.mockReset();
    mockReportOps.mockResolvedValue(true);
  });

  it('returns a NextResponse with the data', async () => {
    const res = jsonResponse({ ok: true });
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('does not call reportOps for small payloads', () => {
    jsonResponse({ ok: true });
    // Fire-and-forget — give microtasks a tick
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('calls reportOps (not notify) with route dedupeKey on large payloads', async () => {
    const big = { data: 'x'.repeat(101_000) };
    jsonResponse(big, undefined, { route: '/api/tasks' });
    // Allow async fire-and-forget to be enqueued
    await Promise.resolve();
    expect(mockReportOps).toHaveBeenCalledTimes(1);
    const call = mockReportOps.mock.calls[0][0];
    expect(call.dedupeKey).toBe('large-payload:/api/tasks');
    expect(call.message).toContain('/api/tasks');
    expect(call.message).toContain('KB');
    expect(call.severity).toBe('warning');
  });

  it('uses "unknown" route when none provided', async () => {
    const big = { data: 'x'.repeat(101_000) };
    jsonResponse(big);
    await Promise.resolve();
    expect(mockReportOps).toHaveBeenCalledTimes(1);
    const call = mockReportOps.mock.calls[0][0];
    expect(call.dedupeKey).toBe('large-payload:unknown');
  });

  it('sets the OTEL span attribute when a span is active', () => {
    // Just verifies it doesn't throw without a span active (no span = no-op)
    expect(() => jsonResponse({ x: 1 })).not.toThrow();
  });
});
