import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-outfit)', 'system-ui', 'sans-serif'],
        display: ['var(--font-fraunces)', 'Georgia', 'serif'],
        mono: ['var(--font-ibm-plex-mono)', 'ui-monospace', 'monospace'],
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
        },
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '16px',
        xl: '24px',
      },
      animation: {
        'pulse-border': 'pulse-border 2s ease-in-out infinite',
        'card-enter': 'card-enter 300ms ease-out',
        'slide-up': 'slide-up 300ms ease-out',
        'dropdown-in': 'dropdown-in 100ms ease-out',
        'status-pulse': 'status-pulse 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-border': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(200, 149, 106, 0)' },
          '50%': { boxShadow: '0 0 0 4px rgba(200, 149, 106, 0.3)' },
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
      },
    },
  },
  plugins: [],
};
export default config;
