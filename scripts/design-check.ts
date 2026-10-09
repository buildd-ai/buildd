#!/usr/bin/env bun
/**
 * Design drift check — a ratchet over design-system debt in apps/web/src.
 *
 *   bun run design:check                          # fail if any rule's total rose
 *   bun run design:check --update                 # lower the baseline to today's counts
 *   bun run design:check --update --allow-increase  # deliberately raise it
 *
 * The baseline stores per-file counts per rule. The gate compares per-rule
 * totals; a failure reports every violation in the files whose count rose, so
 * the output points at the new offender rather than at pre-existing debt.
 *
 * Fails closed: an unreadable file, an unparseable baseline, or (in CI) a
 * missing baseline all exit non-zero. See docs/design/design-system.md
 * "Design drift check".
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

export const BASELINE_FILE = 'scripts/design-check.baseline.json';
const SCAN_ROOT = 'apps/web/src';

export type RuleKey =
  | 'arbitraryFontSizes'
  | 'rawHexColors'
  | 'roundedFullChips'
  | 'handRolledSheets'
  | 'localStatusBadges';

export interface Violation {
  file: string;
  line: number;
  message: string;
}

interface Rule {
  key: RuleKey;
  name: string;
  appliesTo: (file: string) => boolean;
  /** Messages for one line; one entry per violation on that line. */
  check: (line: string) => string[];
}

/** Per-rule, per-file violation counts. Files with zero are omitted. */
export type Counts = Record<RuleKey, Record<string, number>>;

const isUiPrimitive = (f: string) => f.includes('/components/ui/');
const isFlightStrip = (f: string) => f.endsWith('/FlightStrip.tsx');
const isSource = (f: string) => f.endsWith('.ts') || f.endsWith('.tsx');

const FONT_SIZE = /text-\[[0-9.]+px\]/g;
const HEX = /#[0-9A-Fa-f]{6}(?![0-9A-Fa-f])|#[0-9A-Fa-f]{3}(?![0-9A-Fa-f])/;
const STYLING_CONTEXT = /(className|style|bg-|text-|border-|fill-|stroke-|ring-)/;
// rounded-full is only a defect on chip/badge-like elements; avatars and dots are fine.
const CHIP_LIKE = /text-\[[0-9.]+px\]|\buppercase\b|\btext-(chip|eyebrow|xs)\b|\bpx-/;

export const RULES: Rule[] = [
  {
    key: 'arbitraryFontSizes',
    name: 'Arbitrary font sizes',
    appliesTo: f => isSource(f) && !isUiPrimitive(f) && !isFlightStrip(f),
    check: line =>
      (line.match(FONT_SIZE) ?? []).map(
        m => `Found ${m}; use a type-scale role from design-system.md §3 (text-chip, text-eyebrow, text-meta, text-body, text-title, text-lede, text-heading, text-display)`,
      ),
  },
  {
    key: 'rawHexColors',
    name: 'Raw hex colors',
    appliesTo: f => isSource(f) && !isUiPrimitive(f) && !isFlightStrip(f),
    check: line => {
      if (line.includes('http') || line.includes('//') || line.includes('/*')) return [];
      if (!STYLING_CONTEXT.test(line)) return [];
      const hex = line.match(HEX);
      return hex ? [`Found raw hex color ${hex[0]}; use a design token from design-system.md §2`] : [];
    },
  },
  {
    key: 'roundedFullChips',
    name: 'rounded-full on chips',
    appliesTo: f => isSource(f) && !isUiPrimitive(f) && !isFlightStrip(f),
    check: line =>
      /\brounded-full\b/.test(line) && CHIP_LIKE.test(line)
        ? ["Found 'rounded-full' on a chip/badge-like element; chips take the pill radius from Chip (design-system.md §2.6), use Chip from components/ui/ (§4)"]
        : [],
  },
  {
    key: 'handRolledSheets',
    name: 'Hand-rolled sheets',
    appliesTo: f =>
      isSource(f) && !isUiPrimitive(f) && !f.endsWith('/components/BottomSheet.tsx') && !f.endsWith('/components/SideSheet.tsx'),
    check: line =>
      line.includes('fixed inset-0')
        ? ["Found 'fixed inset-0' sheet pattern; use Sheet or BottomSheet per design-system.md §4"]
        : [],
  },
  {
    key: 'localStatusBadges',
    name: 'Local StatusBadges',
    appliesTo: f => f.endsWith('.tsx') && !f.endsWith('/components/StatusBadge.tsx'),
    check: line =>
      /function StatusBadge\b|const StatusBadge\s*=/.test(line)
        ? ['Found local StatusBadge definition; consolidate on components/StatusBadge.tsx or use Chip per design-system.md §4']
        : [],
  },
];

/** Scan in-memory sources. Pure, so tests can feed it fixtures. */
export function scanSources(sources: { path: string; content: string }[]): {
  counts: Counts;
  violations: Record<RuleKey, Violation[]>;
} {
  const counts = Object.fromEntries(RULES.map(r => [r.key, {}])) as Counts;
  const violations = Object.fromEntries(RULES.map(r => [r.key, []])) as unknown as Record<RuleKey, Violation[]>;
  for (const { path, content } of sources) {
    const lines = content.split('\n');
    for (const rule of RULES) {
      if (!rule.appliesTo(path)) continue;
      lines.forEach((text, idx) => {
        for (const message of rule.check(text)) {
          violations[rule.key].push({ file: path, line: idx + 1, message });
          counts[rule.key][path] = (counts[rule.key][path] ?? 0) + 1;
        }
      });
    }
  }
  return { counts, violations };
}

/** Walk the scan root. Any fs error propagates — the check never fails open. */
export function readSources(root = SCAN_ROOT): { path: string; content: string }[] {
  if (!existsSync(root)) throw new Error(`scan root ${root} does not exist`);
  const out: { path: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (isSource(entry.name)) {
        out.push({ path: relative('.', full), content: readFileSync(full, 'utf-8') });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const total = (perFile: Record<string, number> = {}) => Object.values(perFile).reduce((a, b) => a + b, 0);

export function parseBaseline(raw: string): Counts {
  const parsed = JSON.parse(raw);
  for (const rule of RULES) {
    const perFile = parsed?.[rule.key];
    if (!perFile || typeof perFile !== 'object') throw new Error(`baseline is missing rule '${rule.key}'`);
    for (const [file, n] of Object.entries(perFile)) {
      if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`baseline ${rule.key}['${file}'] is not a count`);
    }
  }
  return parsed as Counts;
}

export function serializeBaseline(counts: Counts): string {
  const sorted: Record<string, Record<string, number>> = {};
  for (const rule of RULES) {
    const perFile = counts[rule.key] ?? {};
    sorted[rule.key] = Object.fromEntries(Object.keys(perFile).sort().map(f => [f, perFile[f]]));
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

export interface Regression {
  rule: RuleKey;
  name: string;
  baseline: number;
  current: number;
  /** Every violation in a file whose count rose against the baseline. */
  offenders: Violation[];
}

/** Rules whose total rose, with the violations in the files responsible. */
export function findRegressions(
  baseline: Counts,
  current: Counts,
  violations: Record<RuleKey, Violation[]>,
): Regression[] {
  const out: Regression[] = [];
  for (const rule of RULES) {
    const base = baseline[rule.key] ?? {};
    const now = current[rule.key] ?? {};
    if (total(now) <= total(base)) continue;
    const rose = new Set(Object.keys(now).filter(f => now[f] > (base[f] ?? 0)));
    out.push({
      rule: rule.key,
      name: rule.name,
      baseline: total(base),
      current: total(now),
      offenders: violations[rule.key].filter(v => rose.has(v.file)),
    });
  }
  return out;
}

/**
 * The baseline --update would write. Without allowIncrease, each file keeps
 * min(baseline, current) — paid-down debt is locked in, new debt is not
 * absorbed. Returns the rules that would have risen so the caller can refuse.
 */
export function updatedBaseline(
  baseline: Counts,
  current: Counts,
  allowIncrease: boolean,
): { next: Counts; refused: RuleKey[] } {
  const next = {} as Counts;
  const refused: RuleKey[] = [];
  for (const rule of RULES) {
    const base = baseline[rule.key] ?? {};
    const now = current[rule.key] ?? {};
    if (allowIncrease) {
      next[rule.key] = { ...now };
      continue;
    }
    if (total(now) > total(base)) refused.push(rule.key);
    const perFile: Record<string, number> = {};
    for (const [file, n] of Object.entries(now)) {
      const kept = Math.min(n, base[file] ?? 0);
      if (kept > 0) perFile[file] = kept;
    }
    next[rule.key] = perFile;
  }
  return { next, refused };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const update = args.has('--update');
  const allowIncrease = args.has('--allow-increase');

  const { counts, violations } = scanSources(readSources());

  if (!existsSync(BASELINE_FILE)) {
    if (process.env.CI) {
      console.error(`❌ ${BASELINE_FILE} is missing. Restore it; CI never regenerates the baseline.`);
      process.exit(1);
    }
    writeFileSync(BASELINE_FILE, serializeBaseline(counts));
    console.log(`📋 No baseline found; wrote ${BASELINE_FILE} from the current tree.`);
    return;
  }

  const baseline = parseBaseline(readFileSync(BASELINE_FILE, 'utf-8'));

  if (update) {
    const { next, refused } = updatedBaseline(baseline, counts, allowIncrease);
    if (refused.length > 0) {
      console.error(`❌ Refusing to raise the baseline for: ${refused.join(', ')}. Fix the new violations, or pass --allow-increase deliberately.`);
      process.exit(1);
    }
    writeFileSync(BASELINE_FILE, serializeBaseline(next));
    console.log(`✅ Wrote ${BASELINE_FILE}.`);
    return;
  }

  console.log('🎨 Design drift check\n');
  console.log('   Rule                     | Current | Baseline');
  for (const rule of RULES) {
    console.log(`   ${rule.name.padEnd(24)} | ${String(total(counts[rule.key])).padEnd(7)} | ${total(baseline[rule.key])}`);
  }

  const regressions = findRegressions(baseline, counts, violations);
  if (regressions.length === 0) {
    const lowered = RULES.some(r => total(counts[r.key]) < total(baseline[r.key]));
    console.log(`\n✅ Design drift check passed.${lowered ? ' Debt went down — run `bun run design:check --update` to lock it in.' : ''}`);
    return;
  }

  for (const r of regressions) {
    console.log(`\n❌ ${r.name} rose from ${r.baseline} to ${r.current}:`);
    for (const v of r.offenders) console.log(`   ${v.file}:${v.line}: ${v.message}`);
  }
  console.log('\n❌ Design drift detected. Remove the new violations above.');
  process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`❌ design check failed: ${(err as Error).message}`);
    process.exit(2);
  }
}
