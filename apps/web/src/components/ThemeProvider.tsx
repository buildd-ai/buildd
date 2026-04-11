'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';
type Resolved = 'dark' | 'light';

interface ThemeCtx {
  theme: Theme;
  resolved: Resolved;
  setTheme: (t: Theme) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeCtx>({
  theme: 'dark',
  resolved: 'dark',
  setTheme: () => {},
  cycle: () => {},
});

export const useTheme = () => useContext(ThemeContext);

function getSystemTheme(): Resolved {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolve(theme: Theme): Resolved {
  return theme === 'system' ? getSystemTheme() : theme;
}

function applyTheme(resolved: Resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');
  const [resolved, setResolved] = useState<Resolved>('dark');

  useEffect(() => {
    const stored = localStorage.getItem('buildd-theme') as Theme | null;
    const t = stored && ['dark', 'light', 'system'].includes(stored) ? stored : 'dark';
    setThemeState(t);
    const r = resolve(t);
    setResolved(r);
    applyTheme(r);
  }, []);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      const r = resolve('system');
      setResolved(r);
      applyTheme(r);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem('buildd-theme', t);
    const r = resolve(t);
    setResolved(r);
    applyTheme(r);
  }, []);

  const cycle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, cycle }}>
      {children}
    </ThemeContext.Provider>
  );
}
