import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Smartphone,
  MessageSquare,
  Webhook,
  Key,
  FileText,
  ClipboardList,
  LogOut,
  Send,
  Server,
  Puzzle,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Languages,
  UserCheck,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useRole, type UserRole } from '../hooks/useRole';
import { languageOptions, resolveSupportedLanguage, rtlLanguages, type SupportedLanguage } from '../i18n';
import { healthApi, infraApi } from '../services/api';
import { isComposingKey } from '../utils/composition';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

// unscopedOnly: every route behind the page refuses a key restricted to selected sessions, whatever its role.
const allNavItems = [
  { to: '/', icon: LayoutDashboard, key: 'dashboard' as const, adminOnly: false },
  { to: '/sessions', icon: Smartphone, key: 'sessions' as const, adminOnly: false },
  { to: '/chats', icon: MessageSquare, key: 'chats' as const, adminOnly: false },
  { to: '/number-checker', icon: UserCheck, key: 'numberChecker' as const, adminOnly: false },
  { to: '/webhooks', icon: Webhook, key: 'webhooks' as const, adminOnly: false },
  { to: '/templates', icon: ClipboardList, key: 'templates' as const, adminOnly: false },
  { to: '/api-keys', icon: Key, key: 'apiKeys' as const, adminOnly: true, unscopedOnly: true },
  { to: '/message-tester', icon: Send, key: 'messageTester' as const, adminOnly: false },
  // Backend /infra/* is ADMIN-only; hide the nav item from non-admins (UX + defense-in-depth).
  { to: '/infrastructure', icon: Server, key: 'infrastructure' as const, adminOnly: true, unscopedOnly: true },
  { to: '/plugins', icon: Puzzle, key: 'plugins' as const, adminOnly: true, unscopedOnly: true },
  // Backend /audit is ADMIN-only too.
  { to: '/logs', icon: FileText, key: 'logs' as const, adminOnly: true },
];

const themeIcons = { light: Sun, dark: Moon, system: Monitor };

// The phone layout switches on the query the phone styles in Layout.css sit under. A width test in script disagreed
// with them at a fractional width: at 110% zoom the window width rounds 767.3 CSS px to 767, which the query does
// not match, so the desktop sidebar was drawn and made inert.
const MOBILE_QUERY = '(max-width: 767px)';

export function Layout({ onLogout, userRole }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];
  const themeLabel = t(`theme.${theme}`);
  // toggleTheme cycles light, dark, system. The button's name starts with the mode it shows, the words a voice user
  // says to press it, then names the mode a click selects.
  const themeButtonName = t('common.joinedName', {
    first: themeLabel,
    second: t('theme.toggleTo', {
      value: t(`theme.${theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'}`),
    }),
  });

  const { scoped } = useRole();
  const navItems = allNavItems.filter(
    item => (!item.adminOnly || userRole === 'admin') && (!item.unscopedOnly || !scoped),
  );

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  // Collapsing is a desktop preference: the phone drawer has no collapse control, so it never renders collapsed,
  // and the flag stays as it was for when the window widens again.
  const collapsed = isCollapsed && !isMobile;
  // Show the build-time version immediately, then replace it with the live running version from the
  // backend so a stale-built bundle can't display the wrong number. Falls back silently on error.
  const [version, setVersion] = useState(__APP_VERSION__);
  // A newer published release, shown to admins as a link to its notes. The route is ADMIN-only, refuses a
  // session-scoped key, and answers quietly when GitHub is unreachable or the check is turned off.
  const [update, setUpdate] = useState<{ latest: string; url: string } | null>(null);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const phone = window.matchMedia(MOBILE_QUERY);
    const handleChange = () => {
      setIsMobile(phone.matches);
      if (!phone.matches) setIsMobileOpen(false);
    };
    phone.addEventListener('change', handleChange);
    return () => phone.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    let active = true;
    healthApi
      .check()
      .then(info => {
        if (active && info?.version) setVersion(info.version);
      })
      .catch(() => {
        /* keep the build-time fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (userRole !== 'admin' || scoped) return;
    let active = true;
    infraApi
      .getUpdateCheck()
      .then(check => {
        if (active && check.updateAvailable && check.latest && check.releaseUrl) {
          setUpdate({ latest: check.latest, url: check.releaseUrl });
        }
      })
      .catch(() => {
        /* no notice */
      });
    return () => {
      active = false;
    };
  }, [userRole, scoped]);

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

  // Escape dismisses the innermost overlay: while the language menu is open it takes the key, then the drawer does.
  // The drawer covers the page, so it takes the key before the page's own Escape handlers (on window, in the capture
  // phase) and keeps it from them: one press closed the drawer and the chat open behind it. A dialog renders above
  // the drawer and keeps its own Escape, and so does a composition being committed by an IME.
  useEffect(() => {
    if (!isMobileOpen || isLanguageMenuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isComposingKey(event)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setIsMobileOpen(false);
      // The focused link is about to slide off screen, so hand focus back to the control that opened the drawer.
      mobileMenuButtonRef.current?.focus();
    };

    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [isMobileOpen, isLanguageMenuOpen]);

  useEffect(() => {
    if (!isLanguageMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setIsLanguageMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsLanguageMenuOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isLanguageMenuOpen]);

  const toggleCollapse = () => setIsCollapsed(!isCollapsed);
  const toggleMobile = () => setIsMobileOpen(!isMobileOpen);

  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const languageLabel = languageOptions.find(option => option.value === currentLang)?.compactLabel ?? 'EN';
  const languageButtonName = t('common.joinedName', { first: languageLabel, second: t('common.changeLanguage') });
  const changeLanguage = (language: SupportedLanguage) => {
    setIsLanguageMenuOpen(false);
    void i18n.changeLanguage(language);
  };
  const isRtl = rtlLanguages.includes(currentLang);

  return (
    <div className="layout">
      {isMobile && (
        <header className="mobile-header">
          <button
            ref={mobileMenuButtonRef}
            className="mobile-menu-btn"
            onClick={toggleMobile}
            aria-label={isMobileOpen ? t('common.close') : t('common.expand')}
            aria-expanded={isMobileOpen}
          >
            {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-brand">
            <img src="/openwa_logo.webp" alt="OpenWA" className="sidebar-logo" />
            <span className="brand-name">{t('common.appName')}</span>
          </div>
          <div style={{ width: 40 }} />
        </header>
      )}

      {isMobile && isMobileOpen && <div className="sidebar-overlay" onClick={() => setIsMobileOpen(false)} />}

      <aside
        className={`sidebar ${collapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''} ${isMobileOpen ? 'open' : ''}`}
        // Off screen is not out of reach: keep the closed drawer's links out of the tab order and the reading order.
        inert={isMobile && !isMobileOpen}
      >
        <div className="sidebar-header">
          <img src="/openwa_logo.webp" alt="OpenWA" className="sidebar-logo" />
          {!collapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">{t('common.appName')}</span>
              <span className="brand-version">v{version}</span>
              {update && (
                <a
                  className="brand-update"
                  href={update.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('common.updateAvailable', { version: update.latest })}
                >
                  {t('common.updateAvailable', { version: update.latest })}
                </a>
              )}
            </div>
          )}
          {/* At the end of the header row, or under the logo on the collapsed rail. The icon is picked for the
              reading direction, so the panel side follows the mirrored layout. */}
          {!isMobile && (
            <button
              className="collapse-toggle"
              onClick={toggleCollapse}
              title={isCollapsed ? t('common.expand') : t('common.collapse')}
              aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
            >
              {isCollapsed ? (
                isRtl ? (
                  <PanelRightOpen size={20} />
                ) : (
                  <PanelLeftOpen size={20} />
                )
              ) : isRtl ? (
                <PanelRightClose size={20} />
              ) : (
                <PanelLeftClose size={20} />
              )}
            </button>
          )}
        </div>

        <nav className="sidebar-nav">
          {navItems.map(({ to, icon: Icon, key }) => {
            const label = t(`nav.${key}`);
            return (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                end={to === '/'}
                onClick={handleNavClick}
                title={collapsed ? label : undefined}
              >
                <Icon size={20} />
                {!collapsed && <span>{label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="language-menu" ref={languageMenuRef}>
            <button
              className="theme-toggle-btn"
              onClick={() => setIsLanguageMenuOpen(open => !open)}
              title={languageButtonName}
              aria-label={languageButtonName}
              aria-haspopup="menu"
              aria-expanded={isLanguageMenuOpen}
            >
              <Languages size={18} />
              {!collapsed && <span>{languageLabel}</span>}
            </button>
            {isLanguageMenuOpen && (
              <div className="language-menu-list" role="menu" aria-label={t('common.language')}>
                {languageOptions.map(option => (
                  <button
                    key={option.value}
                    className={`language-menu-item ${option.value === currentLang ? 'active' : ''}`}
                    onClick={() => changeLanguage(option.value)}
                    role="menuitemradio"
                    aria-checked={option.value === currentLang}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="appearance-menu">
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={themeButtonName}
              aria-label={themeButtonName}
            >
              <span className="appearance-button-cue" aria-hidden="true">
                <ThemeIcon size={16} />
              </span>
              {!collapsed && <span>{themeLabel}</span>}
            </button>
          </div>
          <button className="logout-btn" onClick={onLogout} title={collapsed ? t('common.logout') : undefined}>
            <LogOut size={20} />
            {!collapsed && <span>{t('common.logout')}</span>}
          </button>
        </div>
      </aside>

      <main className={`main-content ${collapsed ? 'expanded' : ''} ${isMobile ? 'mobile' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
