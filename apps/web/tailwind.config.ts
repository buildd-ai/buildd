import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Schibsted Grotesk for UI and titles, JetBrains Mono for counts, IDs and
        // lifecycle. Newsreader is `.font-voice` (globals.css), not a family here.
        sans: ['var(--font-schibsted)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-schibsted)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'monospace'],
      },
      // Type roles (docs/design/design-system.md §3). Sizes live in globals.css
      // `--type-*` and switch at md there, so one class covers both widths.
      fontSize: {
        chip: ['var(--type-chip)', { lineHeight: '1' }],
        eyebrow: ['var(--type-eyebrow)', { lineHeight: '1.2' }],
        meta: ['var(--type-meta)', { lineHeight: '1.4' }],
        body: ['var(--type-body)', { lineHeight: '1.5' }],
        title: ['var(--type-title)', { lineHeight: '1.35' }],
        lede: ['var(--type-lede)', { lineHeight: '1.45' }],
        heading: ['var(--type-heading)', { lineHeight: '1.25' }],
        display: ['var(--type-display)', { lineHeight: '1.1' }],
      },
      colors: {
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          subtle: 'var(--primary-subtle)',
          ring: 'var(--primary-ring)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
          text: 'var(--accent-text)',
        },
        surface: {
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
        },
        card: {
          DEFAULT: 'var(--card)',
          hover: 'var(--card-hover)',
          finding: 'var(--card-finding)',
          rightnow: 'var(--card-rightnow)',
          border: 'var(--card-border)',
        },
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        'text-desc': 'var(--text-desc)',
        'border-default': 'var(--border)',
        'border-strong': 'var(--border-strong)',
        status: {
          success: 'var(--status-success)',
          running: 'var(--status-running)',
          warning: 'var(--status-warning)',
          error: 'var(--status-error)',
          info: 'var(--status-info)',
        },
        cat: {
          bug: 'var(--cat-bug)',
          feature: 'var(--cat-feature)',
          refactor: 'var(--cat-refactor)',
          chore: 'var(--cat-chore)',
          docs: 'var(--cat-docs)',
          test: 'var(--cat-test)',
          infra: 'var(--cat-infra)',
          design: 'var(--cat-design)',
          research: 'var(--cat-research)',
        },
      },
      // Three radii (globals.css --radius-*): 3px strip cells (`sm`), 4px pills
      // and controls (DEFAULT, `md`, `full`), 6px cards (`lg` and up). There is
      // no circle: `full` is the pill radius, so do not build ring spinners on
      // it — use <Spinner>. radius-scale.test.ts holds every radius to this set.
      borderRadius: {
        none: '0',
        sm: 'var(--radius-cell)',
        DEFAULT: 'var(--radius-pill)',
        md: 'var(--radius-pill)',
        lg: 'var(--radius-card)',
        xl: 'var(--radius-card)',
        '2xl': 'var(--radius-card)',
        '3xl': 'var(--radius-card)',
        full: 'var(--radius-pill)',
      },
      // No shadows: frames are 1px hairlines (1.5px for a focused card or a
      // decision), so every shadow utility resolves to none.
      boxShadow: {
        none: 'none',
        sm: 'none',
        DEFAULT: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
      },
      animation: {
        'pulse-border': 'pulse-border 2s ease-in-out infinite',
        'card-enter': 'card-enter 300ms ease-out',
        'slide-up': 'slide-up 300ms ease-out',
        'dropdown-in': 'dropdown-in 100ms ease-out',
        'status-pulse': 'status-pulse 2s ease-in-out infinite',
        'timeline-enter': 'timeline-enter 400ms ease-out both',
        'slide-in-right': 'slide-in-right 200ms ease-out',
      },
      keyframes: {
        'pulse-border': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(244, 129, 31, 0)' },
          '50%': { boxShadow: '0 0 0 4px rgba(244, 129, 31, 0.3)' },
        },
        'card-enter': {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        'dropdown-in': {
          '0%': { opacity: '0', transform: 'scale(0.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'status-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        'timeline-enter': {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};
export default config;
