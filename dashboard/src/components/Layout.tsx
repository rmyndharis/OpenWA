import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChatCircleText,
  DeviceMobile,
  Gauge,
  Globe,
  Key,
  ListBullets,
  PaperPlaneTilt,
  Plug,
  SignOut,
  Desktop,
  Sun,
  Moon,
  List,
  X,
  CaretLeft,
  CaretRight,
  Translate,
} from '@phosphor-icons/react';
import { useTheme } from '../hooks/useTheme';
import { type UserRole } from '../hooks/useRole';
import { languageOptions, resolveSupportedLanguage, rtlLanguages, type SupportedLanguage } from '../i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

const allNavItems = [
  { to: '/', icon: Gauge, key: 'dashboard' as const, adminOnly: false },
  { to: '/sessions', icon: DeviceMobile, key: 'sessions' as const, adminOnly: false },
  { to: '/chats', icon: ChatCircleText, key: 'chats' as const, adminOnly: false },
  { to: '/webhooks', icon: Globe, key: 'webhooks' as const, adminOnly: false },
  { to: '/api-keys', icon: Key, key: 'apiKeys' as const, adminOnly: true },
  { to: '/message-tester', icon: PaperPlaneTilt, key: 'messageTester' as const, adminOnly: false },
  { to: '/infrastructure', icon: Desktop, key: 'infrastructure' as const, adminOnly: true },
  { to: '/plugins', icon: Plug, key: 'plugins' as const, adminOnly: true },
  { to: '/logs', icon: ListBullets, key: 'logs' as const, adminOnly: false },
];

const themeIcons = { light: Sun, dark: Moon, system: Desktop };

export function Layout({ onLogout, userRole }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];
  const themeLabel = t(`theme.${theme}`);

  const navItems = allNavItems.filter(item => !item.adminOnly || userRole === 'admin');

  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setIsMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

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
  const changeLanguage = (language: SupportedLanguage) => {
    setIsLanguageMenuOpen(false);
    void i18n.changeLanguage(language);
  };
  const isRtl = rtlLanguages.includes(currentLang);

  return (
    <TooltipProvider>
      <div className="layout">
        {isMobile && (
          <header className="mobile-header">
            <button className="mobile-menu-btn" onClick={toggleMobile} aria-label={t('common.expand')}>
              {isMobileOpen ? <X size={24} /> : <List size={24} />}
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
          className={cn(
            "sidebar flex flex-col h-full bg-background transition-all duration-300 ease-in-out flex-shrink-0",
            isCollapsed ? "w-[64px]" : "w-[240px]",
            isMobile && "mobile fixed inset-y-0 left-0 z-50",
            isMobile && !isMobileOpen && "-translate-x-full",
            isMobileOpen && "translate-x-0"
          )}
        >
          <div className="sidebar-header p-4 flex items-center gap-3">
            <img src="/openwa_logo.webp" alt="OpenWA" className="sidebar-logo h-8 w-8" />
            {!isCollapsed && (
              <div className="sidebar-brand overflow-hidden">
                <span className="brand-name font-bold block whitespace-nowrap">{t('common.appName')}</span>
                <span className="brand-subtitle text-xs text-muted-foreground block whitespace-nowrap">{t('common.appSubtitle')}</span>
              </div>
            )}
          </div>

          {!isMobile && (
            <button
              className="absolute -right-3 top-20 bg-primary text-primary-foreground rounded-full p-1 shadow-md hover:scale-110 transition-transform"
              onClick={toggleCollapse}
              title={isCollapsed ? t('common.expand') : t('common.collapse')}
            >
              {isCollapsed
                ? (isRtl ? <CaretLeft size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />)
                : (isRtl ? <CaretRight size={12} weight="bold" /> : <CaretLeft size={12} weight="bold" />)}
            </button>
          )}

          <nav className="sidebar-nav flex-1 flex flex-col gap-2 p-2">
            {navItems.map(({ to, icon: Icon, key }) => {
              const label = t(`nav.${key}`);
              return (
                <Tooltip key={to} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <NavLink
                      to={to}
                      className={cn(
                        "nav-item flex items-center gap-3 p-3 rounded-lg text-muted-foreground hover:text-foreground transition-colors",
                        isCollapsed && "justify-center px-0"
                      )}
                      end={to === '/'}
                      onClick={handleNavClick}
                    >
                      <div className="flex items-center justify-center size-10 rounded-full transition-colors hover:bg-muted">
                        <Icon size={24} weight="regular" />
                      </div>
                      {!isCollapsed && <span className="font-medium">{label}</span>}
                    </NavLink>
                  </TooltipTrigger>
                  {isCollapsed && (
                    <TooltipContent side="right">
                      {label}
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </nav>

          <div className="sidebar-footer p-2 flex flex-col gap-2">
            <div className="language-menu relative" ref={languageMenuRef}>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    className="flex items-center gap-3 w-full p-3 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setIsLanguageMenuOpen(open => !open)}
                  >
                    <div className="flex items-center justify-center size-10 rounded-full transition-colors hover:bg-muted">
                      <Translate size={24} />
                    </div>
                    {!isCollapsed && <span className="flex-1 text-left">{languageLabel}</span>}
                  </button>
                </TooltipTrigger>
                {isCollapsed && <TooltipContent side="right">Language</TooltipContent>}
              </Tooltip>
              {isLanguageMenuOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-48 bg-popover rounded-lg shadow-xl py-2 z-50">
                  {languageOptions.map(option => (
                    <button
                      key={option.value}
                      className={cn(
                        "w-full px-4 py-2 text-left text-sm hover:bg-muted transition-colors focus:outline-none",
                        option.value === currentLang && "text-whatsapp-green font-bold"
                      )}
                      onClick={() => changeLanguage(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  className="flex items-center gap-3 w-full p-3 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                  onClick={toggleTheme}
                >
                  <div className="flex items-center justify-center size-10 rounded-full transition-colors hover:bg-muted">
                    <ThemeIcon size={24} />
                  </div>
                  {!isCollapsed && <span className="flex-1 text-left">{themeLabel}</span>}
                </button>
              </TooltipTrigger>
              {isCollapsed && <TooltipContent side="right">{themeLabel}</TooltipContent>}
            </Tooltip>

            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button 
                  className="flex items-center gap-3 w-full p-3 rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={onLogout}
                >
                  <SignOut size={24} />
                  {!isCollapsed && <span className="flex-1 text-left">{t('common.logout')}</span>}
                </button>
              </TooltipTrigger>
              {isCollapsed && <TooltipContent side="right">Logout</TooltipContent>}
            </Tooltip>
          </div>
        </aside>

        <main className={cn(
          "main-content flex-1 h-screen flex flex-col overflow-hidden"
        )}>
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}
