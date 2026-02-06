/** @type {import('tailwindcss').Config} */
export default {
  content: ['./ui/index.html', './ui/app.js'],
  theme: {
    extend: {
      backgroundImage: {
        'gradient-primary': 'linear-gradient(135deg, #d946ef, #22d3ee)',
        'gradient-primary-hover': 'linear-gradient(135deg, #c026d3, #06b6d4)',
      },
      keyframes: {
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'chat-fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'pulse-slow': 'pulse 2s infinite',
        'pulse-fast': 'pulse 1.5s ease-in-out infinite',
        'chat-fade-in': 'chat-fade-in 0.15s ease-out',
        'fade-in': 'fade-in 0.15s ease',
      },
    },
  },
  plugins: [],
};
