/**
 * The §16 guard: every row of the docs/specs/workflow-state-kernel.md test
 * matrix has a conformance scenario naming it (or a recorded exemption), and
 * each of those scenarios exists. Remove a mapping and this fails. Lives
 * outside the kernel package because it reads the spec file, and the package
 * imports no Node built-in (workflow-kernel no-buildd-imports test).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_CONFORMANCE_SCENARIOS } from '../../workflow-kernel/src/conformance/all';
import { MATRIX_COVERAGE, matrixProblems, specMatrixRows } from '../../workflow-kernel/src/conformance/matrix-coverage';

const SPEC = join(import.meta.dir, '../../../docs/specs/workflow-state-kernel.md');

const names = ALL_CONFORMANCE_SCENARIOS.map((s) => s.name);
const rows = specMatrixRows(readFileSync(SPEC, 'utf8'));

describe('§16 matrix coverage', () => {
  test('the spec lists the rows the guard expects to read', () => {
    expect(rows.length).toBeGreaterThanOrEqual(38);
    expect(new Set(rows).size).toBe(rows.length);
  });

  test('every row has a scenario that exists, or an exemption with a reason', () => {
    expect(matrixProblems(rows, MATRIX_COVERAGE, names)).toEqual([]);
  });

  test('scenario names are unique, so a row cannot be satisfied by a duplicate', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  test('the guard fails when a row has no scenario, when a mapping names none, and when an exemption has no reason', () => {
    const { S7: _dropped, ...without } = MATRIX_COVERAGE;
    expect(matrixProblems(rows, without, names)).toEqual(['S7: no scenario and no exemption']);
    expect(matrixProblems(rows, { ...MATRIX_COVERAGE, S7: { scenarios: ['S7: renamed away'] } }, names)).toEqual(['S7: "S7: renamed away" matches 0 scenarios, want exactly 1']);
    expect(matrixProblems(rows, { ...MATRIX_COVERAGE, S7: { exempt: 'later' } }, names)).toEqual(['S7: an exemption needs a real reason']);
    expect(matrixProblems([...rows, 'S99'], MATRIX_COVERAGE, names)).toEqual(['S99: no scenario and no exemption']);
  });

  test('an exemption is a recorded exception, not the way to cover a row', () => {
    const exempt = Object.entries(MATRIX_COVERAGE).filter(([, e]) => 'exempt' in e).map(([id]) => id);
    expect(exempt).toEqual(['S14']);
  });
});
