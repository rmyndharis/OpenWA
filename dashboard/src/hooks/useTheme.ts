import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'openwa_theme';
// Legacy key from the removed palette picker (pre-0.9.0). Cleaned up on mount so old installs
// don't carry dead state; the picker was dropped for being hard to maintain and off-brand.
const LEGACY_PALETTE_KEY = 'openwa_palette';

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return isTheme(saved) ? saved : 'system';
  });

  const applyTheme = useCallback((newTheme: Theme) => {
    const root = document.documentElement;

    if (newTheme === 'system') {
      // Remove data-theme to let CSS media query handle it
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', newTheme);
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme, applyTheme]);

  // One-time cleanup of the removed palette picker's storage + document attribute.
  useEffect(() => {
    localStorage.removeItem(LEGACY_PALETTE_KEY);
    document.documentElement.removeAttribute('data-palette');
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => {
      if (prev === 'light') return 'dark';
      if (prev === 'dark') return 'system';
      return 'light';
    });
  }, []);

  // Get the resolved theme (what's actually displayed)
  const resolvedTheme =
    theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;

  return { theme, setTheme, toggleTheme, resolvedTheme };
}
