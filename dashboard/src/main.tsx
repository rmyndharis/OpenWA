import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { i18nReady } from './i18n';
import './index.css';
import App from './App.tsx';
import { syncThemeFavicon, type ThemePreference } from './utils/themeAssets';

// Apply the stored theme BEFORE first paint: useTheme() only runs inside Layout, so standalone
// routes (Login) otherwise flash the OS theme on reload even when the user explicitly picked one.
// Mirrors applyTheme: an explicit choice sets data-theme; system/absent leaves it to the media query.
const storedTheme = localStorage.getItem('openwa_theme');
if (storedTheme === 'light' || storedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', storedTheme);
}
const initialTheme: ThemePreference =
  storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system' ? storedTheme : 'system';
syncThemeFavicon(initialTheme);

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
systemTheme.addEventListener('change', () => {
  const currentTheme = localStorage.getItem('openwa_theme');
  if (currentTheme === 'light' || currentTheme === 'dark') return;
  syncThemeFavicon('system');
});

// The active locale is fetched rather than bundled into the entry, so first paint waits for it —
// otherwise the shell renders raw keys and swaps to real copy a tick later. A catalogue that fails
// to arrive does not hold this up: i18next settles init either way, falling back to English or, if
// nothing loads at all, to raw keys. The second handler is therefore belt and braces rather than the
// live path — but it is what guarantees that no future change to that contract can leave the
// dashboard blank, which is a worse failure than untranslated text.
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

void i18nReady.then(render, render);
