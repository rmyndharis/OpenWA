import { darkThemeLogoUrl, lightThemeLogoUrl } from '../utils/themeAssets';
import './ThemeLogo.css';

export function ThemeLogo({ className = '', alt = 'OpenWA' }: { className?: string; alt?: string }) {
  return (
    <span className={`theme-logo ${className}`.trim()} role="img" aria-label={alt}>
      <img className="theme-logo-image theme-logo-light" src={lightThemeLogoUrl} alt="" aria-hidden="true" />
      <img className="theme-logo-image theme-logo-dark" src={darkThemeLogoUrl} alt="" aria-hidden="true" />
    </span>
  );
}
