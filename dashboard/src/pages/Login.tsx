import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeSlash, Translate } from '@phosphor-icons/react';
import { GithubIcon } from '../components/GithubIcon';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL } from '../services/api';
import { cn } from '../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

interface LoginProps {
  onLogin: (apiKey: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError(t('login.apiKeyRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
      });

      if (response.ok) {
        onLogin(apiKey);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.message || t('login.invalidKey'));
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-8 bg-background p-4">
      <div className="flex flex-col items-center gap-2">
        <img
          src="/openwa_logo.webp"
          alt="OpenWA"
          className="size-14 rounded-xl object-contain"
        />
        <span className="text-base font-bold tracking-tight text-foreground">
          {t('common.appName')}
        </span>
        <span className="text-[10px] font-medium text-muted-foreground">
          {t('login.version', {
            version: __APP_VERSION__,
            date: new Date(__BUILD_TIME__).toLocaleDateString(),
          })}
        </span>
      </div>

      <Card className="w-full max-w-sm rounded-2xl border border-border/70 bg-popover">
        <CardHeader className="pb-0 text-center">
          <CardTitle className="text-base font-semibold text-foreground">
            {t('login.connect')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <Select
            value={currentLang}
            onValueChange={value => changeLanguage(value as SupportedLanguage)}
          >
            <SelectTrigger
              className="h-8 w-full gap-2 rounded-lg border border-border/70 bg-background px-3 text-xs text-muted-foreground data-placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-whatsapp-green"
              size="default"
            >
              <Translate size={16} className="shrink-0 text-muted-foreground" />
              <SelectValue placeholder={t('common.language')} />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-popover text-foreground ring-0">
              {languageOptions.map(option => (
                <SelectItem key={option.value} value={option.value} className="rounded-lg text-foreground focus:bg-transparent focus:text-inherit focus-visible:outline-none data-highlighted:bg-whatsapp-green/20 data-highlighted:text-foreground">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="apiKey" className="text-xs font-semibold text-foreground">
                {t('login.apiKey')}
              </label>
              <div className="relative">
                <input
                  id="apiKey"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={t('login.apiKeyPlaceholder')}
                  className={cn(
                    "h-8 w-full rounded-lg border border-border/70 bg-background px-3 pr-9 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors focus:ring-1 focus:ring-whatsapp-green",
                    error && "ring-1 ring-destructive/30"
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {error && (
                <span className="flex items-center gap-1 text-xs font-medium text-destructive">
                  {error}
                </span>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className={cn(
                "inline-flex h-8 w-full items-center justify-center rounded-lg bg-whatsapp-green px-4 text-xs font-semibold text-whatsapp-deep-dark transition-all hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              {isLoading ? t('login.connecting') : t('login.connect')}
            </button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            {t('login.help')}{' '}
            <a
              href="https://github.com/rmyndharis/OpenWA/blob/main/docs/01-project-overview.md"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-whatsapp-green hover:underline"
            >
              {t('login.viewDocs')}
            </a>
          </p>
        </CardContent>
      </Card>

      <footer className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <a
          href="https://github.com/rmyndharis/OpenWA"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-whatsapp-green transition-colors"
          aria-label="GitHub"
        >
          <GithubIcon size={16} />
        </a>
        <span>{t('login.footer')}</span>
      </footer>
    </div>
  );
}
