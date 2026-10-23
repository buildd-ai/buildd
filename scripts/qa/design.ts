/**
 * Design vs built — pure helpers, no I/O, no browser.
 *
 * A design is one HTML file, each screen a `section[data-screen=<id>]` with a
 * `data-viewport="WxH"` (and optionally `data-theme`), shown alone at
 * `#<id>` (mission "Designs in buildd"). A spec criterion names the screens
 * it covers on `screen:` lines. Given the criteria and the page captures,
 * this decides which design screen each captured route is compared with:
 *
 *   - only screens a criterion names; a criterion with no screen pairs
 *     nothing, and its route is judged as before, from the words alone;
 *   - an explicit `routes[screen]` in the plan wins (a fixture route, say);
 *   - else by name: `/app/missions/:id` is the `mission` page, and pairs with
 *     `phone-mission`, `desktop-mission` (and `phone-mission-…`);
 *   - and by device: a phone screen (under 768px) with a phone capture.
 *
 * The plan (QA_DESIGN) is JSON, inline or a file:
 *   { "design": { "file": "<path>" | "url": "<https signed URL>",
 *                 "artifactId"?, "revision"?, "sha256"?, "theme"?: "light" | "dark" },
 *     "criteria": [{ "id": "AC-4", "text"?: "...", "screens": ["phone-mission"] }],
 *     "routes"?: { "<screen-id>": "<route or /pattern/:id>" } }
 *
 * The section scan repeats apps/web/src/lib/design-preview.ts on purpose: the
 * harness runs from a sparse trunk checkout that has scripts/qa only.
 */

export type Viewport = { width: number; height: number };
export type Theme = 'light' | 'dark';

export interface DesignPlan {
  design: { file?: string; url?: string; artifactId?: string; revision?: number; sha256?: string; theme?: Theme };
  criteria: Array<{ id: string; text?: string; screens: string[] }>;
  routes: Record<string, string>;
}

export interface DesignScreen { id: string; viewport: Viewport | null; theme: Theme | null }

/** A screen to render: its size and theme resolved, and whether the file has it. */
export interface ScreenToCapture { id: string; viewport: Viewport | null; theme: Theme | null; inFile: boolean }

export interface DesignPair {
  captureId: string;
  route: string;
  screen: string;
  /** The criteria that name this screen. */
  criteria: string[];
  designViewport: Viewport | null;
  builtViewport: Viewport | null;
  /** The design's theme for this screen; the built page should be shot in it. */
  theme: Theme | null;
  builtTheme: Theme | null;
  /** Shot in the other theme: compare layout and words only (Night/Day parity is its own check). */
  themeMismatch: boolean;
}

/** The fields of captures.json this reads. */
export interface PairableCapture {
  id: string;
  path: string;
  screenshotFile?: string;
  viewport?: Viewport | null;
  theme?: string | null;
  skipped?: boolean;
  error?: string;
  bootFailure?: string;
  configError?: string;
}

/** Below this a screen or a shot is a phone (Tailwind's `md`, as viewport.ts). */
export const PHONE_MAX_WIDTH = 768;
const PHONE: Viewport = { width: 390, height: 844 };
const DESKTOP: Viewport = { width: 1440, height: 900 };
/** A screen id goes into a URL fragment and a CSS selector, so only plain ids pass. */
export const SCREEN_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const theme = (v: unknown): Theme | null => (v === 'light' || v === 'dark' ? v : null);

export function parseViewport(v: unknown): Viewport | null {
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(v);
  return m && +m[1] > 0 && +m[2] > 0 ? { width: +m[1], height: +m[2] } : null;
}

/** QA_DESIGN as JSON text. Throws with the field at fault. */
export function parseDesignPlan(text: string): DesignPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('QA_DESIGN is not valid JSON');
  }
  if (!isRecord(raw) || !isRecord(raw.design)) throw new Error('QA_DESIGN needs a design object');
  const d = raw.design;
  const file = typeof d.file === 'string' && d.file.trim() ? d.file.trim() : undefined;
  const url = typeof d.url === 'string' && d.url.trim() ? d.url.trim() : undefined;
  if (!file && !url) throw new Error('QA_DESIGN needs design.file or design.url');
  if (file && url) throw new Error('QA_DESIGN: design.file or design.url, not both');
  if (url && !/^https:\/\//i.test(url)) throw new Error('QA_DESIGN: design.url must be https');
  if (d.theme !== undefined && !theme(d.theme)) throw new Error('QA_DESIGN: design.theme must be "light" or "dark"');
  const revision = Number(d.revision);

  const criteria = (Array.isArray(raw.criteria) ? raw.criteria : []).map((c, i) => {
    if (!isRecord(c) || typeof c.id !== 'string' || !c.id) throw new Error(`QA_DESIGN: criteria[${i}] needs an id`);
    const screens = Array.isArray(c.screens) ? c.screens : [];
    for (const s of screens) if (typeof s !== 'string' || !SCREEN_ID.test(s)) throw new Error(`QA_DESIGN: criteria[${i}] has a screen id that is not a plain id`);
    return { id: c.id, ...(typeof c.text === 'string' ? { text: c.text } : {}), screens: [...new Set(screens as string[])] };
  });

  const routes: Record<string, string> = {};
  if (raw.routes !== undefined) {
    if (!isRecord(raw.routes)) throw new Error('QA_DESIGN: routes must map a screen id to a route');
    for (const [s, r] of Object.entries(raw.routes)) {
      if (!SCREEN_ID.test(s) || typeof r !== 'string' || !r.startsWith('/')) throw new Error(`QA_DESIGN: routes.${s} must be a route starting with /`);
      routes[s] = r;
    }
  }

  return {
    design: {
      ...(file ? { file } : { url }),
      ...(typeof d.artifactId === 'string' ? { artifactId: d.artifactId } : {}),
      ...(Number.isInteger(revision) && revision > 0 ? { revision } : {}),
      ...(typeof d.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(d.sha256) ? { sha256: d.sha256.toLowerCase() } : {}),
      ...(theme(d.theme) ? { theme: theme(d.theme)! } : {}),
    },
    criteria,
    routes,
  };
}

const SECTION_RE = /<section\b([^>]*)>/gi;
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? m[1] ?? m[2] ?? m[3] ?? null : null;
}

/** A last-resort size from the id's prefix. */
function inferViewport(id: string): Viewport | null {
  if (/^(phone|mobile)\b/i.test(id)) return PHONE;
  if (/^(desktop|web|wide)\b/i.test(id)) return DESKTOP;
  return null;
}

/** The screens the file declares, by text scan: the file is never parsed as a document here. */
export function designScreensFromHtml(html: string): Map<string, DesignScreen> {
  const out = new Map<string, DesignScreen>();
  for (const m of html.matchAll(SECTION_RE)) {
    const id = attr(m[1], 'data-screen');
    if (!id || out.has(id)) continue;
    out.set(id, { id, viewport: parseViewport(attr(m[1], 'data-viewport')) ?? inferViewport(id), theme: theme(attr(m[1], 'data-theme')) });
  }
  return out;
}

/** Every screen a criterion names, once, in criterion order. */
export function namedScreens(plan: DesignPlan): string[] {
  const out: string[] = [];
  for (const c of plan.criteria) for (const s of c.screens) if (!out.includes(s)) out.push(s);
  return out;
}

export function screensToCapture(plan: DesignPlan, inFile: Map<string, DesignScreen>): ScreenToCapture[] {
  return namedScreens(plan).map((id) => {
    const s = inFile.get(id);
    return { id, viewport: s?.viewport ?? inferViewport(id), theme: s?.theme ?? plan.design.theme ?? null, inFile: !!s };
  });
}

const DEVICE_PREFIX = /^(phone|mobile|tablet|desktop|web|wide)-/i;

/** `phone-task-running` → `task-running`. */
export function screenPage(id: string): string {
  return id.replace(DEVICE_PREFIX, '').toLowerCase();
}

/** `/app/missions/abc?x=1` → `mission`; `/app/home` → `home`. */
export function routePage(route: string): string {
  const segs = route.split(/[?#]/)[0].split('/').filter(Boolean);
  const first = (segs[0] === 'app' ? segs[1] : segs[0]) ?? '';
  return first.toLowerCase().replace(/s$/, '');
}

function routeMatches(pattern: string, route: string): boolean {
  if (pattern === route) return true;
  const [pp, pq = ''] = pattern.split('?');
  const [rp, rq = ''] = route.split('?');
  if (pq !== rq) return false;
  const a = pp.split('/');
  const b = rp.split('/');
  return a.length === b.length && a.every((s, i) => (s.startsWith(':') ? !!b[i] : s === b[i]));
}

const isPhone = (v: Viewport | null) => !!v && v.width < PHONE_MAX_WIDTH;

export function mapRoutesToScreens(
  plan: DesignPlan,
  inFile: Map<string, DesignScreen>,
  captures: readonly PairableCapture[],
  opts: { fallbackViewport?: Viewport | null } = {},
): { pairs: DesignPair[]; unmatchedScreens: string[] } {
  const screens = screensToCapture(plan, inFile);
  const shot = captures.filter((c) => c.screenshotFile && !c.skipped && !c.error && !c.bootFailure && !c.configError);
  const pairs: DesignPair[] = [];
  for (const c of shot) {
    const builtViewport = c.viewport ?? opts.fallbackViewport ?? null;
    for (const s of screens) {
      const explicit = plan.routes[s.id];
      const routeOk = explicit
        ? routeMatches(explicit, c.path)
        : routePage(c.path) !== '' && (screenPage(s.id) === routePage(c.path) || screenPage(s.id).startsWith(`${routePage(c.path)}-`));
      if (!routeOk) continue;
      if (!s.viewport || !builtViewport || isPhone(s.viewport) !== isPhone(builtViewport)) continue;
      const builtTheme = theme(c.theme);
      pairs.push({
        captureId: c.id,
        route: c.path,
        screen: s.id,
        criteria: plan.criteria.filter((x) => x.screens.includes(s.id)).map((x) => x.id),
        designViewport: s.viewport,
        builtViewport,
        theme: s.theme,
        builtTheme,
        themeMismatch: !!s.theme && !!builtTheme && s.theme !== builtTheme,
      });
    }
  }
  const unmatchedScreens = screens.map((s) => s.id).filter((id) => !pairs.some((p) => p.screen === id));
  return { pairs, unmatchedScreens };
}
