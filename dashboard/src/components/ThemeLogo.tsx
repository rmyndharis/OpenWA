import { useTheme } from '../hooks/useTheme';
import { darkThemeLogoUrl, lightThemeLogoUrl } from '../utils/themeAssets';
import './ThemeLogo.css';

export function ThemeLogo({ className = '', alt = 'OpenWA' }: { className?: string; alt?: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <img
      className={`theme-logo theme-logo-image ${className}`.trim()}
      src={resolvedTheme === 'dark' ? darkThemeLogoUrl : lightThemeLogoUrl}
      alt={alt}
    />
  );
}
