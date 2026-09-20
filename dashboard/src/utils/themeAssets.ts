export type ThemePreference = 'light' | 'dark' | 'system';

const assetVersion =
  typeof __BUILD_TIME__ === 'string' && __BUILD_TIME__ ? encodeURIComponent(__BUILD_TIME__) : 'development';

export const lightThemeLogoUrl = `/openwa_logo_claro.webp?v=${assetVersion}`;
export const darkThemeLogoUrl = `/openwa_logo.webp?v=${assetVersion}`;

export function resolveThemeLogoUrl(theme: ThemePreference, prefersDark: boolean): string {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  return dark ? darkThemeLogoUrl : lightThemeLogoUrl;
}

export function syncThemeFavicon(theme: ThemePreference): void {
  const favicon = document.querySelector<HTMLLinkElement>('#openwa-favicon');
  if (!favicon) return;
  favicon.href = resolveThemeLogoUrl(theme, window.matchMedia('(prefers-color-scheme: dark)').matches);
}
