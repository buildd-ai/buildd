import { describe, it, expect } from 'bun:test';
import { selectMissionsNeedingBackfill } from '../scripts/backfill-flight-strip-cache';

// AC-13: idempotent backfill — a mission already carrying a cache is skipped,
// not recomputed, on a re-run.
describe('AC-13: backfill idempotency', () => {
  it('selects only missions with a null cache', () => {
    const rows = [
      { id: 'm1', flightStripCache: null },
      { id: 'm2', flightStripCache: { bars: [], foldedBars: 0 } },
      { id: 'm3', flightStripCache: null },
    ];
    expect(selectMissionsNeedingBackfill(rows)).toEqual(['m1', 'm3']);
  });

  it('a second run over the same rows (now all populated) selects nothing', () => {
    const firstRun = [
      { id: 'm1', flightStripCache: null },
      { id: 'm2', flightStripCache: null },
    ];
    const selected = selectMissionsNeedingBackfill(firstRun);
    expect(selected).toEqual(['m1', 'm2']);

    // Simulate the writes that would have happened for the selected ids.
    const afterFirstRun = firstRun.map(r =>
      selected.includes(r.id) ? { ...r, flightStripCache: { bars: [], foldedBars: 0 } } : r,
    );
    expect(selectMissionsNeedingBackfill(afterFirstRun)).toEqual([]);
  });

  it('an empty candidate set is a no-op, not an error', () => {
    expect(selectMissionsNeedingBackfill([])).toEqual([]);
  });
});
