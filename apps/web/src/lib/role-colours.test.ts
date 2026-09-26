import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ROLES } from './default-roles';
import { ROLE_COLOR_VALUES } from '@/components/ColorSwatches';

/**
 * The accent orange is reserved for action/progress (ui_designer skill), and
 * green/amber/red are reserved for status. Builder and Researcher used to
 * default to terracotta and amber, which read as the accent — and, on the day
 * page, failed 3:1 against the paper background. These assertions pin the
 * property (distinct + legible) against the live tokens in globals.css rather
 * than against a hex, so a token change re-checks the roles.
 */

const CSS = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8');

function themeBlock(selector: string): string {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`theme block ${selector} not found in globals.css`);
  return CSS.slice(start, CSS.indexOf('}', start));
}

function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block);
  if (!m) throw new Error(`--${name} not found`);
  return m[1];
}

const NIGHT = themeBlock(':root, [data-theme="dark"]');
const DAY = themeBlock('[data-theme="light"]');
const THEMES = { night: NIGHT, day: DAY };

function channels(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab, scaled ×100 — a perceptual distance where ~2 is "just noticeable". */
function oklab(hex: string): number[] {
  const [r, g, b] = channels(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const MIN_DISTANCE = 9;
const MIN_CONTRAST = 3; // WCAG 1.4.11 non-text contrast — role dots, rails, chips.

const bySlug = Object.fromEntries(DEFAULT_ROLES.map(r => [r.slug, r]));
const RETUNED = ['builder', 'researcher'] as const;

describe('default role colours stay off the reserved accent/status hues', () => {
  for (const slug of RETUNED) {
    const colour = bySlug[slug].color;

    it(`${slug} (${colour}) is perceptually distinct from accent and status tokens in both themes`, () => {
      for (const [theme, block] of Object.entries(THEMES)) {
        for (const name of ['accent', 'accent-text', 'status-success', 'status-warning', 'status-error']) {
          const reserved = token(block, name);
          expect({ theme, name, d: distance(colour, reserved) >= MIN_DISTANCE }).toEqual({ theme, name, d: true });
        }
      }
    });

    it(`${slug} (${colour}) is distinct from every other default role`, () => {
      for (const other of DEFAULT_ROLES) {
        if (other.slug === slug) continue;
        expect({ other: other.slug, ok: distance(colour, other.color) >= MIN_DISTANCE }).toEqual({ other: other.slug, ok: true });
      }
    });

    it(`${slug} (${colour}) passes ${MIN_CONTRAST}:1 on page and card surfaces in both themes`, () => {
      for (const [theme, block] of Object.entries(THEMES)) {
        for (const surface of ['surface-1', 'surface-2', 'card']) {
          const ratio = contrast(colour, token(block, surface));
          expect({ theme, surface, ok: ratio >= MIN_CONTRAST }).toEqual({ theme, surface, ok: true });
        }
      }
    });

    it(`${slug} (${colour}) is offered by the colour picker, so its default reads as selected`, () => {
      expect(ROLE_COLOR_VALUES.map(v => v.toLowerCase())).toContain(colour.toLowerCase());
    });
  }
});

describe('role colour data migration', () => {
  const dir = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'core', 'drizzle');
  const file = readdirSync(dir).find(f => /^\d{4}_role_colours_off_accent\.sql$/.test(f));
  const sql = file ? readFileSync(join(dir, file), 'utf8') : '';
  const statements = sql
    .split('--> statement-breakpoint')
    .map(s => s.replace(/--[^\n]*\n/g, '').trim())
    .filter(Boolean);

  it('exists (matched by name so a renumber on collision does not break it)', () => {
    expect(file).toBeDefined();
  });

  it('only touches rows still on the old default colour for that slug', () => {
    const OLD: Record<string, string> = { builder: '#d4724a', researcher: '#d97706' };
    expect(statements.length).toBe(RETUNED.length);
    for (const slug of RETUNED) {
      const stmt = statements.find(s => s.includes(`'${slug}'`));
      expect(stmt).toBeDefined();
      expect(stmt!).toMatch(/^UPDATE\s+"workspace_skills"\s+SET\s+"color"\s*=/i);
      expect(stmt!).toContain(`'${bySlug[slug].color}'`);
      expect(stmt!).toMatch(new RegExp(`"slug"\\s*=\\s*'${slug}'`));
      expect(stmt!).toMatch(new RegExp(`lower\\("color"\\)\\s*=\\s*'${OLD[slug]}'`));
    }
  });

  it('never deletes, and never inlines observed row data', () => {
    expect(sql).not.toMatch(/\bDELETE\b|\bINSERT\b|\bid\s+IN\b/i);
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
