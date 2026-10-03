import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages, KeyRound, ArrowRight, ShieldCheck } from 'lucide-react';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL } from '../services/api';
import { xenwaApi, type XenwaPublicConfig } from '../services/xenwa';
import './Login.css';
import './LoginXenwa.css';

interface LoginProps {
  onLogin: (apiKey: string, role?: string, engineType?: string) => void;
  /** Reason a XenAI Tech sign-in failed, shown above the button. */
  ssoError?: string | null;
}

export function Login({ onLogin, ssoError }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const [sso, setSso] = useState<XenwaPublicConfig | null>(null);
  const [showKeyLogin, setShowKeyLogin] = useState(false);

  useEffect(() => {
    xenwaApi
      .config()
      .then(setSso)
      .catch(() => setSso(null));
  }, []);
  const keyFormVisible = showKeyLogin || !sso?.ssoEnabled;

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
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': key,
        },
      });

      if (response.ok) {
        // The validate body already carries the key's role — hand it up so the app can set it
        // directly instead of re-validating the same key a second time.
        const data: { role?: string; engineType?: string } = await response.json().catch(() => ({}));
        onLogin(key, data.role, typeof data.engineType === 'string' ? data.engineType : undefined);
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
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/xenwa_logo.png" alt="XenWA" className="logo-icon" />
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

        <div className="login-intro">
          <h1 className="login-title">
            Welcome to <span className="gradient-text">XenWA</span>
          </h1>
          <p className="login-subtitle">WhatsApp management &amp; marketing for teams</p>
        </div>

        {sso?.ssoEnabled && (
          <div className="sso-block">
            {ssoError && <div className="sso-error">{ssoError}</div>}
            <a className="sso-btn" href={sso.ssoStartUrl}>
              <ShieldCheck size={18} />
              <span>Continue with XenAI Tech</span>
              <ArrowRight size={16} />
            </a>
            {!showKeyLogin && (
              <button type="button" className="sso-alt" onClick={() => setShowKeyLogin(true)}>
                <KeyRound size={14} /> Use an API key instead
              </button>
            )}
          </div>
        )}

        {keyFormVisible && (
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
              {error && <span className="error-message">{error}</span>}
            </div>

            <button type="submit" className="connect-btn" disabled={isLoading}>
              {isLoading ? t('login.connecting') : t('login.connect')}
            </button>
          </form>
        )}
      </div>

      <footer className="login-footer">
        <span>{t('login.footer')}</span>
        <a
          href={sso?.platformUrl ?? 'https://xenaitech.com'}
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
        >
          xenaitech.com
        </a>
      </footer>
    </div>
  );
}
