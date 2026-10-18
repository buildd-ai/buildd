/**
 * One set of criterion ids for docs/specs/workflow-kernel-library.md and the approved Living Spec
 * of the same name. Tests are tagged with the repo ids, so a verdict recorded against a Living Spec
 * id lands on the wrong test when the two files give one number two meanings.
 *
 * The Living Spec owns AC-1 to AC-48 (AC-31 to AC-38 are the state-kernel §13.13 rules, AC-39 to
 * AC-42 the review-approval criteria, AC-43 to AC-48 the escalation view). A criterion this file
 * defines that the Living Spec does not has an id above AC-48. A criterion this file defines inside
 * the Living Spec's range is one it implements and says so in its first line.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIVING_SPEC_MAX = 48;
// Living Spec ids this file defines on purpose (the same criterion, same number).
const SHARED_IDS = new Set<number>([
  ...Array.from({ length: 30 }, (_, i) => i + 1),
]);

const spec = readFileSync(join(import.meta.dir, '../../../../../docs/specs/workflow-kernel-library.md'), 'utf8');

function definedCriteria() {
  const out: { id: number; line: string }[] = [];
  const lines = spec.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- AC-(\d+)\b/);
    if (!m) continue;
    let text = lines[i];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j++) text += ' ' + lines[j].trim();
    out.push({ id: Number(m[1]), line: text });
  }
  return out;
}

describe('workflow-kernel-library criterion ids against the Living Spec', () => {
  const defined = definedCriteria();

  test('the file defines criteria at all', () => {
    expect(defined.length).toBeGreaterThan(30);
  });

  test('no id is defined twice', () => {
    const ids = defined.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test('an id inside the Living Spec range is one the Living Spec shares, or says it implements it', () => {
    const unknown = defined.filter(
      (c) => c.id <= LIVING_SPEC_MAX && !SHARED_IDS.has(c.id) && !/implements Living Spec criteri/.test(c.line),
    );
    // Fix: number a criterion of this file above AC-48 (with a `replaces:` line when it moves),
    // or, when it is the Living Spec's own criterion, add its id to SHARED_IDS here.
    expect(unknown.map((c) => `AC-${c.id}`)).toEqual([]);
  });
});
