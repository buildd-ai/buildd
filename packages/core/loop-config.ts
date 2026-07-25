import type { LoopConfig, LoopExitCondition } from '@buildd/shared';

export const LOOP_MAX_LOOPS_DEFAULT = 5;
export const LOOP_MAX_LOOPS_MIN = 1;
export const LOOP_MAX_LOOPS_MAX = 50;
export const LOOP_BACKOFF_MINUTES_DEFAULT = 0;
export const LOOP_BACKOFF_MINUTES_MAX = 10_080; // 7 days

const EXIT_CONDITION_TYPES = new Set(['command', 'pr_checks_green', 'structured_predicate']);
const PREDICATE_OPERATORS = new Set(['eq', 'neq', 'exists', 'gt', 'gte', 'lt', 'lte']);
const LOOP_CONFIG_KEYS = new Set(['exitCondition', 'maxLoops', 'backoffMinutes']);

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, context: string): void {
  const unknown = Object.keys(obj).filter(k => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown ${context} key(s): ${unknown.join(', ')}`);
  }
}

function parseExitCondition(raw: unknown, verificationCommand?: string): LoopExitCondition {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('loopConfig.exitCondition must be an object');
  }
  const cond = raw as Record<string, unknown>;
  const type = cond.type;

  if (typeof type !== 'string' || !EXIT_CONDITION_TYPES.has(type)) {
    throw new Error(
      `loopConfig.exitCondition.type must be one of: ${[...EXIT_CONDITION_TYPES].join(', ')}`
    );
  }

  if (type === 'command') {
    rejectUnknownKeys(cond, new Set(['type', 'command']), 'exitCondition');
    const rawCommand = cond.command;
    // Fallback to task context verificationCommand when command is absent
    const resolvedCommand =
      typeof rawCommand === 'string' && rawCommand.trim() !== ''
        ? rawCommand.trim()
        : typeof verificationCommand === 'string' && verificationCommand.trim() !== ''
          ? verificationCommand.trim()
          : null;
    if (!resolvedCommand) {
      throw new Error(
        'exitCondition.command is required and must be non-blank (or set context.verificationCommand)'
      );
    }
    // Reject conflicting command vs verificationCommand
    if (
      typeof rawCommand === 'string' && rawCommand.trim() !== '' &&
      typeof verificationCommand === 'string' && verificationCommand.trim() !== '' &&
      rawCommand.trim() !== verificationCommand.trim()
    ) {
      throw new Error(
        'exitCondition.command conflicts with context.verificationCommand — they must match or one must be omitted'
      );
    }
    return { type: 'command', command: resolvedCommand };
  }

  if (type === 'pr_checks_green') {
    rejectUnknownKeys(cond, new Set(['type']), 'exitCondition');
    return { type: 'pr_checks_green' };
  }

  // type === 'structured_predicate'
  rejectUnknownKeys(cond, new Set(['type', 'predicate']), 'exitCondition');
  const predicate = cond.predicate;
  if (predicate === null || predicate === undefined || typeof predicate !== 'object' || Array.isArray(predicate)) {
    throw new Error('exitCondition.predicate is required for structured_predicate');
  }
  const pred = predicate as Record<string, unknown>;
  rejectUnknownKeys(pred, new Set(['path', 'operator', 'value']), 'exitCondition.predicate');

  if (typeof pred.path !== 'string' || pred.path.trim() === '') {
    throw new Error('exitCondition.predicate.path is required and must be non-blank');
  }
  if (typeof pred.operator !== 'string' || !PREDICATE_OPERATORS.has(pred.operator)) {
    throw new Error(
      `exitCondition.predicate.operator must be one of: ${[...PREDICATE_OPERATORS].join(', ')}`
    );
  }
  if ('value' in pred) {
    const v = pred.value;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error('exitCondition.predicate.value must be a string, number, boolean, or null');
    }
  }

  const result: LoopExitCondition & { type: 'structured_predicate' } = {
    type: 'structured_predicate',
    predicate: {
      path: pred.path.trim(),
      operator: pred.operator as 'eq' | 'neq' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte',
      ...('value' in pred ? { value: pred.value as string | number | boolean | null } : {}),
    },
  };
  return result;
}

/**
 * Parse and validate a raw loopConfig value.
 *
 * - Returns null for null/undefined input (tasks without a loop are unchanged).
 * - Normalizes maxLoops (default 5) and backoffMinutes (default 0).
 * - Rejects unknown keys and malformed exitCondition shapes.
 *
 * @param raw - Value from the API request body or DB
 * @param verificationCommand - Optional task.context.verificationCommand for command-type fallback/conflict check
 */
export function parseLoopConfig(raw: unknown, verificationCommand?: string): LoopConfig | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('loopConfig must be an object');
  }
  const cfg = raw as Record<string, unknown>;
  rejectUnknownKeys(cfg, LOOP_CONFIG_KEYS, 'loopConfig');

  if (!('exitCondition' in cfg)) {
    throw new Error('loopConfig.exitCondition is required');
  }
  const exitCondition = parseExitCondition(cfg.exitCondition, verificationCommand);

  let maxLoops = LOOP_MAX_LOOPS_DEFAULT;
  if ('maxLoops' in cfg && cfg.maxLoops !== undefined) {
    if (typeof cfg.maxLoops !== 'number' || !Number.isInteger(cfg.maxLoops)) {
      throw new Error('loopConfig.maxLoops must be an integer');
    }
    if (cfg.maxLoops < LOOP_MAX_LOOPS_MIN || cfg.maxLoops > LOOP_MAX_LOOPS_MAX) {
      throw new Error(
        `loopConfig.maxLoops must be between ${LOOP_MAX_LOOPS_MIN} and ${LOOP_MAX_LOOPS_MAX}`
      );
    }
    maxLoops = cfg.maxLoops;
  }

  let backoffMinutes = LOOP_BACKOFF_MINUTES_DEFAULT;
  if ('backoffMinutes' in cfg && cfg.backoffMinutes !== undefined) {
    if (typeof cfg.backoffMinutes !== 'number' || !Number.isInteger(cfg.backoffMinutes)) {
      throw new Error('loopConfig.backoffMinutes must be an integer');
    }
    if (cfg.backoffMinutes < 0 || cfg.backoffMinutes > LOOP_BACKOFF_MINUTES_MAX) {
      throw new Error(
        `loopConfig.backoffMinutes must be between 0 and ${LOOP_BACKOFF_MINUTES_MAX}`
      );
    }
    backoffMinutes = cfg.backoffMinutes;
  }

  return { exitCondition, maxLoops, backoffMinutes };
}
