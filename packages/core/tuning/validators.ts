import { z } from 'zod';

/** Integer clamped into [min, max]. Non-numbers and non-finite values are invalid. */
export function clampedInt(min: number, max: number) {
  return z
    .number()
    .refine(Number.isFinite)
    .transform((n) => Math.min(max, Math.max(min, Math.round(n))));
}

/** Float clamped into [min, max]. Non-numbers and non-finite values are invalid. */
export function clampedNumber(min: number, max: number) {
  return z
    .number()
    .refine(Number.isFinite)
    .transform((n) => Math.min(max, Math.max(min, n)));
}

/** Non-blank markdown body, bounded so a bad private file cannot blow up a prompt. */
export function markdownPrompt(opts: { maxLength?: number } = {}) {
  return z
    .string()
    .refine((s) => s.trim().length > 0)
    .refine((s) => s.length <= (opts.maxLength ?? 50_000));
}

export type TuningValidator<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false } } | ((v: unknown) => T);

export function runValidator<T>(validate: TuningValidator<T>, value: unknown): { ok: true; value: T } | { ok: false } {
  try {
    if (typeof validate === 'function') return { ok: true, value: validate(value) };
    const r = validate.safeParse(value);
    return r.success ? { ok: true, value: r.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}
