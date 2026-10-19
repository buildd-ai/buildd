import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  NEON_BYTES_FIELD,
  NEON_EGRESS_BY_LOADER,
  NEON_EGRESS_LIMIT_BYTES,
  NEON_EGRESS_MONITOR,
  NEON_LOADER_FIELD,
} from '../ops-monitors/neon-egress';

describe('database-egress monitor (R-28, R-42)', () => {
  it('pages above 1 GB over an hour, checked at least every 15 minutes', () => {
    expect(NEON_EGRESS_MONITOR.threshold).toBe(1_073_741_824);
    expect(NEON_EGRESS_MONITOR.threshold).toBe(NEON_EGRESS_LIMIT_BYTES);
    expect(NEON_EGRESS_MONITOR.operator).toBe('Above');
    expect(NEON_EGRESS_MONITOR.rangeMinutes).toBe(60);
    expect(NEON_EGRESS_MONITOR.intervalMinutes).toBeLessThanOrEqual(15);
  });

  it('sums Neon response bytes in production into one value v', () => {
    const apl = NEON_EGRESS_MONITOR.aplQuery;
    expect(apl).toContain(NEON_BYTES_FIELD);
    expect(apl).toContain('summarize v = sum(');
    expect(apl).toContain('"production"');
  });

  it('names the loader the code actually puts on the span', () => {
    const src = readFileSync(new URL('../db/query-label.ts', import.meta.url), 'utf8');
    expect(src).toContain("'buildd.db.loader'");
    expect(NEON_LOADER_FIELD).toContain('buildd.db.loader');
  });

  it('the drill-down groups by page route and loader', () => {
    expect(NEON_EGRESS_BY_LOADER).toContain('by route, loader');
    expect(NEON_EGRESS_BY_LOADER).toContain(NEON_LOADER_FIELD);
    expect(NEON_EGRESS_BY_LOADER).toContain('on trace_id');
  });
});
