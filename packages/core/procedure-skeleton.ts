/**
 * The procedure skeleton of a run: the ordered tool/step NAMES a worker called,
 * with consecutive repeats collapsed and capped at PROCEDURE_MAX_STEPS. Pure.
 * It reads only the structural fields of worker milestones (phase `ops`, action
 * `tool`), never a label, path, command or any transcript text.
 */
export const PROCEDURE_MAX_STEPS = 40;

/** A tool or MCP action name; anything else (prose, paths) is dropped. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export interface ProcedureStep { name: string; count: number }
export interface ProcedureSkeleton { steps: ProcedureStep[]; totalCalls: number; truncated: boolean }

function namesOf(m: unknown): string[] {
  if (!m || typeof m !== 'object') return [];
  const e = m as { type?: unknown; ops?: unknown; tool?: unknown };
  const raw: unknown[] =
    e.type === 'phase' ? (Array.isArray(e.ops) ? e.ops : [])
    : e.type === 'action' ? [e.tool]
    : [];
  return raw.filter((n): n is string => typeof n === 'string' && NAME_RE.test(n));
}

export function buildProcedureSkeleton(milestones: unknown): ProcedureSkeleton {
  const all: ProcedureStep[] = [];
  let totalCalls = 0;
  for (const m of Array.isArray(milestones) ? milestones : []) {
    for (const name of namesOf(m)) {
      totalCalls++;
      const last = all[all.length - 1];
      if (last && last.name === name) last.count++;
      else all.push({ name, count: 1 });
    }
  }
  return { steps: all.slice(0, PROCEDURE_MAX_STEPS), totalCalls, truncated: all.length > PROCEDURE_MAX_STEPS };
}
