import { expect, it } from 'bun:test';
import { manifestCounts } from './coordination-stats';
it('reports absent populations without pretending coverage is zero', () => {
 expect(manifestCounts([])).toEqual({ total: 0, concrete: 0, advisory: 0, none: 0, concreteShare: null });
});
it('weights the share by tasks rather than averaging group percentages', () => {
 expect(manifestCounts([{total: 9, concrete: 9, advisory: 0, none: 0}, {total: 1, concrete: 0, advisory: 1, none: 0}]).concreteShare).toBe(0.9);
});
