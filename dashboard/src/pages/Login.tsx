import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { authApi } from '../services/api';
import './Login.css';

export interface LoginSessionResult {
  role?: string;
  engineType?: string;
  scoped?: boolean;
  apiKeyId?: string;
}

interface LoginProps {
  onLogin: (session: LoginSessionResult) => void;
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
    // The stored key is matched against key prefixes elsewhere, so a pasted space must not reach it.
    const key = apiKey.trim();
    if (!key) {
      setError(t('login.apiKeyRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await authApi.createSession(key);

      if (response.ok) {
        // The session exchange sets the HttpOnly browser cookie and returns non-secret session
        // metadata so the app can hydrate role/scope/engine without a second round-trip.
        const data: {
          valid?: unknown;
          role?: string;
          engineType?: string;
          scoped?: unknown;
          apiKeyId?: unknown;
        } = await response.json().catch(() => ({}));
        // A 200 is the gateway's answer only if it says the session is valid: a reverse proxy
        // serving the app's HTML for a misrouted /api would otherwise sign any typed text in as a viewer.
        if (data.valid !== true) {
          setError(t('login.connectionError'));
          return;
        }
        // The exchange answers 200 even when the browser drops its cookie (the API on another site, blocked
        // cookies), and every request after it would answer 401 and land back here with no message.
        if ((await authApi.getSession()).status === 401) {
          setError(t('login.sessionNotKept'));
          return;
        }
        setApiKey('');
        onLogin({
          role: data.role,
          engineType: typeof data.engineType === 'string' ? data.engineType : undefined,
          scoped: data.scoped === true,
          apiKeyId: typeof data.apiKeyId === 'string' && data.apiKeyId.length > 0 ? data.apiKeyId : undefined,
        });
      } else {
        // A 5xx, or a body that is not the gateway's JSON (a proxy error page while it restarts), says
        // nothing about the key; a refusal keeps the gateway's reason (expired, revoked, rate limited).
        const errorData: { message?: unknown } = await response.json().catch(() => ({}));
        const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
        setError(reason || t(response.status === 401 ? 'login.invalidKey' : 'login.connectionError'));
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/openwa_logo.webp" alt="OpenWA" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              // ISO date (YYYYMMDD) so the format is stable across locales/regions instead of the
              // locale-dependent toLocaleDateString() which renders differently per browser region.
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <label htmlFor="apiKey">{t('login.apiKey')}</label>
            <div className="input-wrapper">
              <input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={t('login.apiKeyPlaceholder')}
                className={error ? 'error' : ''}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'apiKey-error' : undefined}
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? t('common.hideApiKey') : t('common.showApiKey')}
              >
                {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && (
              <span id="apiKey-error" className="error-message" role="alert">
                {error}
              </span>
            )}
          </div>

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? t('login.connecting') : t('login.connect')}
          </button>
        </form>

        <p className="login-help">
          {t('login.help')}{' '}
          <a href="https://docs.open-wa.org" target="_blank" rel="noopener noreferrer">
            {t('login.viewDocs')}
          </a>
        </p>
      </div>

      <footer className="login-footer">
        <span>{t('login.footer')}</span>
        <a
          href="https://github.com/rmyndharis/OpenWA"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          aria-label="GitHub"
        >
          <GithubIcon size={18} />
        </a>
      </footer>
    </div>
  );
}
