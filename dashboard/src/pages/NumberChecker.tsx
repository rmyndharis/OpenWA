import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UserCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  Send,
  Download,
  Trash2,
  Shield,
  Smartphone,
  Phone,
  Search,
} from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { copyToClipboard } from '../utils/clipboard';
import { useSessionsQuery } from '../hooks/queries';
import { contactApi } from '../services/api';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { batchStopMessage, useNumberCheck, type CheckResultItem } from '../hooks/useNumberCheck';
import { escapeCsvCell } from '../utils/csv';
import { normalizePhoneText } from '../utils/phone';
import { keepsSameKey } from '../utils/authLifecycle';
import { isComposingKey } from '../utils/composition';
import './NumberChecker.css';

// Every lookup is an outbound WhatsApp query that counts against the gateway's per-IP limit on this route
// (100 a minute by default) and against the linked account's standing, so one run is capped.
export const NUMBER_CHECK_BATCH_MAX = 100;

// The most digits a phone number has (E.164). Spaces are formatting inside one number, so two whole numbers on one line
// fold into a longer run of digits: such an entry is refused, never looked up as a number nobody typed.
const PHONE_MAX_DIGITS = 15;

const timeOfDay = (iso: string) => new Date(iso).toLocaleTimeString();

export function NumberChecker() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.numberChecker'));
  const navigate = useNavigate();
  const toast = useToast();
  const { canWrite } = useRole();
  // The bulk run lives above the routes, so it is still going (or its rows are still here) when this page opens again.
  const run = useNumberCheck();
  const isCheckingBatch = run.running;
  const batchResults = run.results;
  const batchProgress = run.progress;
  const batchStop = run.stopped;

  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const readySessions = useMemo(() => sessions.filter(s => s.status === 'ready'), [sessions]);

  const [selectedSession, setSelectedSession] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'single' | 'batch'>(
    isCheckingBatch || batchResults.length > 0 ? 'batch' : 'single',
  );

  // The chosen session, else the first ready one (API requires session UUID). A chosen session that leaves
  // the ready list on a refetch would otherwise stay in use while the select shows the first option.
  const currentSession = readySessions.some(s => s.id === selectedSession)
    ? selectedSession
    : (readySessions[0]?.id ?? '');

  // Single Check State
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isCheckingSingle, setIsCheckingSingle] = useState(false);
  const [singleResult, setSingleResult] = useState<CheckResultItem | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [recentChecks, setRecentChecks] = useState<CheckResultItem[]>([]);

  // Batch Check State
  const [batchInput, setBatchInput] = useState(() => run.numbers.join('\n'));
  const [batchDelay, setBatchDelay] = useState<number>(run.delay);
  // The session a running bulk run is bound to. Both selects are locked meanwhile, so they keep showing it even if
  // the chosen session leaves the ready list and returns during the run, and a single check goes to it too.
  const shownSession = isCheckingBatch ? run.session : currentSession;
  const singleRun = useRef(0);
  useEffect(() => {
    singleRun.current += 1;
    setIsCheckingSingle(false);
    return () => {
      singleRun.current += 1;
    };
  }, [shownSession]);
  const [batchFilter, setBatchFilter] = useState<'all' | 'registered' | 'unregistered' | 'failed'>('all');

  // Opt-in: the +91 rewrite would turn any other country's 10-digit or 0-prefixed number into an Indian one.
  const [autoPrefix91, setAutoPrefix91] = useState(false);

  // Format and clean phone number based on digit rules
  const formatNumberForCheck = useCallback(
    (typed: string, applyPrefix = autoPrefix91) => {
      const raw = normalizePhoneText(typed);
      let digits = raw.replace(/[^0-9]/g, '');
      const isInternational = raw.trim().startsWith('+') || digits.startsWith('00');
      // 1. If international dial exit code 00 is present (e.g. 009196...), strip '00'
      if (digits.startsWith('00') && digits.length >= 12) {
        digits = digits.substring(2);
      }
      // 2. If user entered +91 with domestic trunk 0 (e.g. +91 096... -> 13 digits), strip trunk 0
      if (applyPrefix && digits.length === 13 && digits.startsWith('910')) {
        digits = '91' + digits.substring(3);
      }
      // 3. If domestic 11 digits starting with 0 (e.g. 096xxxxxxxx), strip leading 0
      if (applyPrefix && !isInternational && digits.length === 11 && digits.startsWith('0')) {
        digits = digits.substring(1);
      }
      // 4. If exactly 10 digits and autoPrefix is true: impose India country code (+91)
      if (applyPrefix && !isInternational && digits.length === 10) {
        return '91' + digits;
      }
      // 5. If 12 digits (already has country code, e.g. 91xxxxxxxxxx) or any other format: keep as-is
      return digits;
    },
    [autoPrefix91],
  );

  // Preview formatted single number
  const singleFormattedNumber = useMemo(() => {
    return formatNumberForCheck(phoneNumber);
  }, [phoneNumber, formatNumberForCheck]);
  const singleTypedDigits = normalizePhoneText(phoneNumber).replace(/[^0-9]/g, '');
  const singleTooLong = singleFormattedNumber.length > PHONE_MAX_DIGITS;

  // Batch parsing statistics
  const batchParsedStats = useMemo(() => {
    const lines = normalizePhoneText(batchInput)
      .split(/[\n,;\t\u060C\u061B]+/)
      .map(n => n.trim())
      .filter(n => n.length > 0);

    let tenDigitsCount = 0;
    let twelveDigitsCount = 0;
    let otherCount = 0;
    let tooLongCount = 0;

    const uniqueFormatted = new Set<string>();

    for (const raw of lines) {
      // Measured after the 00 strip and the +91 rewrite, so a 00-prefixed full-length number is still one number.
      const formatted = formatNumberForCheck(raw, autoPrefix91);
      if (formatted.length > PHONE_MAX_DIGITS) {
        tooLongCount++;
        continue;
      }
      let d = raw.replace(/[^0-9]/g, '');
      const isInternational = raw.startsWith('+') || d.startsWith('00');
      if (d.startsWith('00') && d.length >= 12) d = d.substring(2);
      if (autoPrefix91 && d.length === 13 && d.startsWith('910')) d = '91' + d.substring(3);
      if (autoPrefix91 && !isInternational && d.length === 11 && d.startsWith('0')) d = d.substring(1);

      if (!isInternational && d.length === 10) {
        tenDigitsCount++;
      } else if (d.length === 12) {
        twelveDigitsCount++;
      } else if (d.length >= 7) {
        otherCount++;
      }
      if (formatted.length >= 7) {
        uniqueFormatted.add(formatted);
      }
    }

    return {
      totalLines: lines.length,
      uniqueCount: uniqueFormatted.size,
      tenDigitsCount,
      twelveDigitsCount,
      otherCount,
      tooLongCount,
      list: Array.from(uniqueFormatted),
    };
  }, [batchInput, autoPrefix91, formatNumberForCheck]);
  const batchOverLimit = batchParsedStats.uniqueCount > NUMBER_CHECK_BATCH_MAX;

  // Perform single check
  const handleSingleCheck = async () => {
    if (!canWrite || isCheckingSingle) return;
    const formatted = formatNumberForCheck(phoneNumber);
    if (!formatted) {
      toast.error(t('numberChecker.toast.enterNumber'));
      return;
    }
    if (formatted.length > PHONE_MAX_DIGITS) {
      toast.error(t('numberChecker.single.tooLong', { max: PHONE_MAX_DIGITS }));
      return;
    }
    if (!shownSession) {
      toast.error(t('numberChecker.toast.noSession'));
      return;
    }

    const request = ++singleRun.current;
    const sameKey = keepsSameKey();
    const isCurrent = () => singleRun.current === request && sameKey();
    setIsCheckingSingle(true);
    try {
      const res = await contactApi.checkNumber(shownSession, formatted);
      if (!isCurrent()) return;
      let avatar: string | null = null;
      if (res.exists && res.whatsappId) {
        try {
          const pic = await contactApi.profilePicture(shownSession, res.whatsappId);
          avatar = pic.url;
        } catch {
          // Profile picture is optional
        }
      }

      if (!isCurrent()) return;
      const item: CheckResultItem = {
        ...res,
        status: res.exists ? 'registered' : 'unregistered',
        error: null,
        avatarUrl: avatar,
        timestamp: new Date().toISOString(),
      };

      setSingleResult(item);
      setRecentChecks(prev => [item, ...prev.filter(p => p.number !== item.number).slice(0, 9)]);
    } catch (err) {
      if (!isCurrent()) return;
      toast.error(
        t('numberChecker.toast.checkFailed'),
        err instanceof Error ? err.message : t('numberChecker.toast.unknownError'),
      );
    } finally {
      if (singleRun.current === request) setIsCheckingSingle(false);
    }
  };

  // Copy WhatsApp ID
  const handleCopy = async (id: string) => {
    // The house helper: over plain HTTP on a LAN address navigator.clipboard does not exist.
    if (await copyToClipboard(id)) {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    }
  };

  // Perform batch check
  const handleStartBatch = () => {
    if (!canWrite || isCheckingBatch) return;
    const numbers = batchParsedStats.list;

    if (numbers.length === 0) {
      toast.error(t('numberChecker.toast.enterNumbers'));
      return;
    }
    if (!currentSession) {
      toast.error(t('numberChecker.toast.noSession'));
      return;
    }

    setBatchFilter('all');
    void run.start(numbers, currentSession, batchDelay);
  };

  // Filter batch results
  const filteredBatchResults = useMemo(() => {
    if (batchFilter === 'registered') return batchResults.filter(r => r.status === 'registered');
    if (batchFilter === 'unregistered') return batchResults.filter(r => r.status === 'unregistered');
    if (batchFilter === 'failed') return batchResults.filter(r => r.status === 'failed');
    return batchResults;
  }, [batchResults, batchFilter]);

  // Export batch results as CSV
  const handleExportCSV = () => {
    if (batchResults.length === 0) return;
    // The export stays English: it is data for other tools, and a header that follows the dashboard's
    // language would break whatever reads it.
    const header = 'Phone Number,Has WhatsApp,WhatsApp ID,Error,Checked At\n';
    const rows = batchResults
      .map(r => {
        const hasWa = r.status === 'failed' ? 'Error' : r.exists ? 'Yes' : 'No';
        return [r.number, hasWa, r.whatsappId, r.error, r.timestamp].map(escapeCsvCell).join(',');
      })
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `whatsapp_account_check_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const registeredCount = batchResults.filter(r => r.status === 'registered').length;
  const unregisteredCount = batchResults.filter(r => r.status === 'unregistered').length;
  const failedCount = batchResults.filter(r => r.status === 'failed').length;

  return (
    <div className="number-checker">
      <PageHeader
        title={t('nav.numberChecker')}
        subtitle={t('numberChecker.subtitle')}
        badge={
          <span className="nc-status-badge registered">
            <Shield size={14} /> {t('numberChecker.zeroMessages')}
          </span>
        }
      />

      {/* Session Alert if none ready */}
      {!loadingSessions && readySessions.length === 0 && (
        <div className="nc-alert warning">
          <div className="nc-alert-icon">
            <AlertCircle size={22} />
          </div>
          <div className="nc-alert-content">
            <strong>{t('numberChecker.noSession.title')}</strong>
            <p style={{ margin: '0.25rem 0 0' }}>{t('numberChecker.noSession.desc')}</p>
          </div>
          <button className="nc-alert-action" onClick={() => navigate('/sessions')}>
            <Smartphone size={16} /> {t('numberChecker.noSession.goToSessions')}
          </button>
        </div>
      )}

      {/* Mode Tabs */}
      <div className="nc-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'single'}
          className={`nc-tab ${activeTab === 'single' ? 'active' : ''}`}
          onClick={() => setActiveTab('single')}
        >
          <Phone size={18} /> {t('numberChecker.tabs.single')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'batch'}
          className={`nc-tab ${activeTab === 'batch' ? 'active' : ''}`}
          onClick={() => setActiveTab('batch')}
        >
          <UserCheck size={18} /> {t('numberChecker.tabs.bulk')}
        </button>
      </div>

      {activeTab === 'single' ? (
        <>
          <div className="nc-grid">
            {/* Input Card */}
            <div className="nc-card">
              <h2 className="nc-card-title">{t('numberChecker.single.title')}</h2>

              <div className="nc-form-group">
                <label htmlFor="nc-single-session" className="nc-label">
                  {t('numberChecker.session.label')}
                </label>
                <select
                  id="nc-single-session"
                  aria-label={t('numberChecker.session.label')}
                  className="nc-input"
                  value={shownSession}
                  onChange={e => setSelectedSession(e.target.value)}
                  disabled={readySessions.length === 0 || isCheckingBatch}
                >
                  {readySessions.length === 0 ? (
                    <option value="">{t('numberChecker.session.none')}</option>
                  ) : (
                    readySessions.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.phone ? `(${s.phone})` : ''}
                      </option>
                    ))
                  )}
                </select>
                <span className="nc-hint">{t('numberChecker.session.hint')}</span>
              </div>

              <div className="nc-form-group">
                <label htmlFor="nc-single-phone" className="nc-label">
                  {t('numberChecker.single.phoneLabel')}
                </label>
                <div className="nc-input-row">
                  <input
                    id="nc-single-phone"
                    type="text"
                    dir="ltr"
                    className="nc-input"
                    placeholder={t('numberChecker.single.phonePlaceholder')}
                    value={phoneNumber}
                    onChange={e => setPhoneNumber(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !isComposingKey(e.nativeEvent)) handleSingleCheck();
                    }}
                    disabled={isCheckingSingle}
                  />
                  <button
                    className="nc-btn nc-btn-primary"
                    onClick={handleSingleCheck}
                    disabled={
                      !canWrite ||
                      isCheckingSingle ||
                      !phoneNumber.trim() ||
                      singleTooLong ||
                      readySessions.length === 0
                    }
                  >
                    {isCheckingSingle ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
                    {isCheckingSingle ? t('numberChecker.single.checking') : t('numberChecker.single.check')}
                  </button>
                </div>

                <label className="nc-checkbox-group">
                  <input
                    type="checkbox"
                    className="nc-checkbox"
                    checked={autoPrefix91}
                    onChange={e => setAutoPrefix91(e.target.checked)}
                    disabled={isCheckingSingle}
                  />
                  <span className="nc-checkbox-label">
                    <Trans i18nKey="numberChecker.single.autoPrefix" components={{ strong: <strong /> }} />
                  </span>
                </label>

                {phoneNumber.trim() && singleTooLong && (
                  <span className="nc-batch-limit" role="status">
                    {t('numberChecker.single.tooLong', { max: PHONE_MAX_DIGITS })}
                  </span>
                )}
                {phoneNumber.trim() && !singleTooLong && (
                  <div className="nc-format-preview">
                    {singleTypedDigits.length === 10 && singleFormattedNumber === '91' + singleTypedDigits ? (
                      <span className="nc-format-pill highlight">
                        <Trans
                          i18nKey="numberChecker.preview.prefixed"
                          values={{ number: singleFormattedNumber }}
                          components={{ strong: <strong dir="ltr" /> }}
                        />
                      </span>
                    ) : singleFormattedNumber.length === 12 && singleFormattedNumber === singleTypedDigits ? (
                      <span className="nc-format-pill">
                        <Trans
                          i18nKey="numberChecker.preview.kept"
                          values={{ number: singleFormattedNumber }}
                          components={{ strong: <strong dir="ltr" /> }}
                        />
                      </span>
                    ) : (
                      <span className="nc-format-pill">
                        <Trans
                          i18nKey="numberChecker.preview.digits"
                          values={{ number: singleFormattedNumber, digits: singleFormattedNumber.length }}
                          components={{ strong: <strong dir="ltr" /> }}
                        />
                      </span>
                    )}
                  </div>
                )}
                <span className="nc-hint">
                  {autoPrefix91 ? t('numberChecker.prefixHint.single') : t('numberChecker.prefixHint.off')}
                </span>
              </div>

              <div className="nc-alert info" style={{ marginTop: '1.5rem', marginBottom: 0 }}>
                <div className="nc-alert-icon">
                  <Shield size={20} />
                </div>
                <div className="nc-alert-content" style={{ fontSize: '0.8125rem' }}>
                  <Trans i18nKey="numberChecker.single.silent" components={{ strong: <strong /> }} />
                </div>
              </div>
            </div>

            {/* Result Card: always rendered, so a finished check is announced as a change inside it. */}
            <div className="nc-card" role="status">
              <h2 className="nc-card-title">{t('numberChecker.single.resultTitle')}</h2>

              {isCheckingSingle ? (
                <div className="nc-result-placeholder">
                  <Loader2 size={36} className="animate-spin" style={{ color: 'var(--primary-text)' }} />
                  <span>{t('numberChecker.single.querying')}</span>
                </div>
              ) : singleResult ? (
                <div className={`nc-result-card ${singleResult.exists ? 'success' : 'not-found'}`}>
                  <div className="nc-result-top">
                    {singleResult.avatarUrl ? (
                      <img
                        src={singleResult.avatarUrl}
                        alt={t('numberChecker.result.avatarAlt')}
                        className="nc-avatar"
                      />
                    ) : (
                      <div className="nc-avatar-fallback">{singleResult.exists ? 'WA' : '?'}</div>
                    )}
                    <div className="nc-result-header-text">
                      <div className="nc-result-phone">
                        <bdi dir="ltr">+{singleResult.number}</bdi>
                      </div>
                      {singleResult.exists ? (
                        <span className="nc-status-badge registered">
                          <CheckCircle2 size={15} /> {t('numberChecker.result.registered')}
                        </span>
                      ) : (
                        <span className="nc-status-badge unregistered">
                          <XCircle size={15} /> {t('numberChecker.result.notRegistered')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="nc-details-grid">
                    <div className="nc-detail-row">
                      <span className="nc-detail-label">{t('numberChecker.result.status')}</span>
                      <span className="nc-detail-value" style={{ fontFamily: 'inherit' }}>
                        {singleResult.exists ? t('numberChecker.result.active') : t('numberChecker.result.none')}
                      </span>
                    </div>

                    {singleResult.exists && singleResult.whatsappId && (
                      <div className="nc-detail-row">
                        <span className="nc-detail-label">{t('numberChecker.result.jid')}</span>
                        <span className="nc-detail-value">
                          <bdi dir="ltr">{singleResult.whatsappId}</bdi>
                          <button
                            className="nc-copy-btn"
                            onClick={() => handleCopy(singleResult.whatsappId!)}
                            title={t('numberChecker.result.copyJid')}
                          >
                            {copiedId ? <Check size={12} /> : <Copy size={12} />}
                            {copiedId ? t('numberChecker.result.copied') : t('numberChecker.result.copy')}
                          </button>
                        </span>
                      </div>
                    )}

                    <div className="nc-detail-row">
                      <span className="nc-detail-label">{t('numberChecker.result.checkedAt')}</span>
                      <span className="nc-detail-value" style={{ fontFamily: 'inherit', fontWeight: 'normal' }}>
                        <bdi>{timeOfDay(singleResult.timestamp)}</bdi>
                      </span>
                    </div>
                  </div>

                  {singleResult.exists && (
                    <div className="nc-result-actions">
                      <button
                        className="nc-btn nc-btn-primary"
                        style={{ flex: 1 }}
                        onClick={() => navigate('/message-tester')}
                      >
                        <Send size={16} /> {t('numberChecker.result.openTester')}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="nc-result-placeholder">
                  <UserCheck size={40} />
                  <span>{t('numberChecker.single.empty')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Recent Checks Table */}
          {recentChecks.length > 0 && (
            <div className="nc-history-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 className="nc-card-title" style={{ margin: 0 }}>
                  {t('numberChecker.recent.title')}
                </h2>
                <button
                  className="nc-btn nc-btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8125rem' }}
                  onClick={() => setRecentChecks([])}
                >
                  <Trash2 size={14} /> {t('numberChecker.recent.clear')}
                </button>
              </div>

              <div className="nc-table-wrap" tabIndex={0} role="region" aria-label={t('numberChecker.recent.title')}>
                <table className="nc-history-table">
                  <thead>
                    <tr>
                      <th>{t('numberChecker.table.phone')}</th>
                      <th>{t('numberChecker.table.status')}</th>
                      <th>{t('numberChecker.table.id')}</th>
                      <th>{t('numberChecker.table.time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentChecks.map((item, idx) => (
                      <tr key={`${item.number}-${idx}`}>
                        <td style={{ fontWeight: 600 }}>
                          <bdi dir="ltr">+{item.number}</bdi>
                        </td>
                        <td>
                          {item.status === 'registered' ? (
                            <span className="nc-status-badge registered">
                              <CheckCircle2 size={13} /> {t('numberChecker.status.registered')}
                            </span>
                          ) : item.status === 'failed' ? (
                            <span
                              className="nc-status-badge error"
                              title={item.error || t('numberChecker.status.failed')}
                            >
                              <AlertCircle size={13} /> {t('numberChecker.status.failed')}
                            </span>
                          ) : (
                            <span className="nc-status-badge unregistered">
                              <XCircle size={13} /> {t('numberChecker.status.unregistered')}
                            </span>
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>
                          <bdi dir="ltr">{item.whatsappId || '-'}</bdi>
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>
                          <bdi>{timeOfDay(item.timestamp)}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Batch / Bulk Number Checker Tab */
        <div className="nc-card">
          <h2 className="nc-card-title">{t('numberChecker.bulk.title')}</h2>

          <div className="nc-grid" style={{ marginBottom: '1.5rem' }}>
            <div>
              <div className="nc-form-group">
                <label htmlFor="nc-batch-session" className="nc-label">
                  {t('numberChecker.session.label')}
                </label>
                <select
                  id="nc-batch-session"
                  aria-label={t('numberChecker.session.label')}
                  className="nc-input"
                  value={shownSession}
                  onChange={e => setSelectedSession(e.target.value)}
                  disabled={readySessions.length === 0 || isCheckingBatch}
                >
                  {readySessions.length === 0 ? (
                    <option value="">{t('numberChecker.session.none')}</option>
                  ) : (
                    readySessions.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.phone ? `(${s.phone})` : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="nc-form-group">
                <label htmlFor="nc-batch-delay" className="nc-label">
                  {t('numberChecker.bulk.delayLabel')}
                </label>
                <select
                  id="nc-batch-delay"
                  aria-label={t('numberChecker.bulk.delayLabel')}
                  className="nc-input"
                  value={batchDelay}
                  onChange={e => setBatchDelay(Number(e.target.value))}
                  disabled={isCheckingBatch}
                >
                  <option value={1000}>{t('numberChecker.bulk.delay1')}</option>
                  <option value={2000}>{t('numberChecker.bulk.delay2')}</option>
                  <option value={3000}>{t('numberChecker.bulk.delay3')}</option>
                </select>
                <span className="nc-hint">{t('numberChecker.bulk.delayHint')}</span>
              </div>

              <div className="nc-form-group">
                <label className="nc-label">{t('numberChecker.bulk.countryRule')}</label>
                <label className="nc-checkbox-group" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    className="nc-checkbox"
                    checked={autoPrefix91}
                    onChange={e => setAutoPrefix91(e.target.checked)}
                    disabled={isCheckingBatch}
                  />
                  <span className="nc-checkbox-label">
                    <Trans i18nKey="numberChecker.bulk.autoPrefix" components={{ strong: <strong /> }} />
                  </span>
                </label>
                <span className="nc-hint">
                  {autoPrefix91 ? t('numberChecker.prefixHint.bulk') : t('numberChecker.prefixHint.off')}
                </span>
              </div>
            </div>

            <div>
              <div className="nc-form-group">
                <label htmlFor="nc-batch-numbers" className="nc-label">
                  {t('numberChecker.bulk.numbersLabel')}
                </label>
                <textarea
                  id="nc-batch-numbers"
                  dir="ltr"
                  className="nc-textarea"
                  placeholder="919612345678&#10;6281234567890&#10;14155552671"
                  value={batchInput}
                  onChange={e => setBatchInput(e.target.value)}
                  disabled={isCheckingBatch}
                />
                {batchInput.trim() ? (
                  <div className="nc-batch-parse-summary">
                    <span>
                      📋{' '}
                      <Trans
                        i18nKey="numberChecker.bulk.parsed"
                        count={batchParsedStats.uniqueCount}
                        components={{ strong: <strong /> }}
                      />
                    </span>
                    {autoPrefix91 && (
                      <span className="nc-badge-sub">
                        {batchParsedStats.twelveDigitsCount > 0
                          ? t('numberChecker.bulk.tenDigitAddedPreserved', {
                              ten: batchParsedStats.tenDigitsCount,
                              twelve: batchParsedStats.twelveDigitsCount,
                            })
                          : t('numberChecker.bulk.tenDigitAdded', { ten: batchParsedStats.tenDigitsCount })}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="nc-hint">
                    {t('numberChecker.bulk.numbersHint', { max: NUMBER_CHECK_BATCH_MAX })}
                  </span>
                )}
                {batchParsedStats.tooLongCount > 0 && (
                  <span className="nc-batch-limit" role="status">
                    {t('numberChecker.bulk.tooLong', { max: PHONE_MAX_DIGITS, count: batchParsedStats.tooLongCount })}
                  </span>
                )}
                {batchOverLimit && (
                  <span className="nc-batch-limit" role="status">
                    {t('numberChecker.bulk.tooMany', {
                      parsed: batchParsedStats.uniqueCount,
                      max: NUMBER_CHECK_BATCH_MAX,
                      excess: batchParsedStats.uniqueCount - NUMBER_CHECK_BATCH_MAX,
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
            {!isCheckingBatch ? (
              <button
                className="nc-btn nc-btn-primary"
                onClick={handleStartBatch}
                disabled={!canWrite || !batchInput.trim() || readySessions.length === 0 || batchOverLimit}
              >
                <UserCheck size={18} /> {t('numberChecker.bulk.start')}
              </button>
            ) : (
              <button className="nc-btn nc-btn-danger" onClick={run.stop}>
                <Trash2 size={18} /> {t('numberChecker.bulk.stop')}
              </button>
            )}

            {batchResults.length > 0 && !isCheckingBatch && (
              <>
                <button className="nc-btn nc-btn-secondary" onClick={handleExportCSV} aria-describedby="nc-export-hint">
                  <Download size={18} /> {t('numberChecker.bulk.export')}
                </button>
                <span id="nc-export-hint" className="nc-hint" style={{ flexBasis: '100%', margin: 0 }}>
                  {t('numberChecker.bulk.exportHint')}
                </span>
              </>
            )}
          </div>

          {batchStop && (
            <div className="nc-alert warning nc-batch-stopped">
              <div className="nc-alert-icon">
                <AlertCircle size={22} />
              </div>
              <div className="nc-alert-content">
                <strong>{t('numberChecker.bulk.stoppedTitle')}</strong>
                <p style={{ margin: '0.25rem 0 0' }}>{batchStopMessage(t, batchStop)}</p>
              </div>
            </div>
          )}

          {/* Progress & Counters */}
          {(isCheckingBatch || batchResults.length > 0) && (
            <>
              {isCheckingBatch && (
                <div
                  className="nc-progress-bar-container"
                  role="progressbar"
                  aria-label={t('numberChecker.bulk.title')}
                  aria-valuemin={0}
                  aria-valuemax={batchProgress.total}
                  aria-valuenow={batchProgress.current}
                >
                  <div
                    className="nc-progress-bar"
                    style={{
                      width: `${(batchProgress.current / (batchProgress.total || 1)) * 100}%`,
                    }}
                  />
                </div>
              )}

              <div className="nc-batch-stats">
                <div className="nc-stat-box">
                  <div className="nc-stat-number">{batchResults.length}</div>
                  <div className="nc-stat-label">{t('numberChecker.bulk.checked')}</div>
                </div>
                <div className="nc-stat-box">
                  <div className="nc-stat-number" style={{ color: 'var(--success-text)' }}>
                    {registeredCount}
                  </div>
                  <div className="nc-stat-label">{t('numberChecker.status.registered')}</div>
                </div>
                <div className="nc-stat-box">
                  <div className="nc-stat-number" style={{ color: 'var(--text-secondary)' }}>
                    {unregisteredCount}
                  </div>
                  <div className="nc-stat-label">{t('numberChecker.status.notRegistered')}</div>
                </div>
                {failedCount > 0 && (
                  <div className="nc-stat-box">
                    <div className="nc-stat-number" style={{ color: 'var(--error-text)' }}>
                      {failedCount}
                    </div>
                    <div className="nc-stat-label">{t('numberChecker.status.failed')}</div>
                  </div>
                )}
                <div className="nc-stat-box">
                  <div className="nc-stat-number">{Math.max(0, batchProgress.total - batchProgress.current)}</div>
                  <div className="nc-stat-label">{t('numberChecker.bulk.remaining')}</div>
                </div>
              </div>

              {/* Table Filters */}
              <div className="nc-filter-bar">
                <div className="nc-filter-btns">
                  <button
                    aria-pressed={batchFilter === 'all'}
                    className={`nc-filter-btn ${batchFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setBatchFilter('all')}
                  >
                    {t('numberChecker.bulk.all')} ({batchResults.length})
                  </button>
                  <button
                    aria-pressed={batchFilter === 'registered'}
                    className={`nc-filter-btn ${batchFilter === 'registered' ? 'active' : ''}`}
                    onClick={() => setBatchFilter('registered')}
                  >
                    {t('numberChecker.status.registered')} ({registeredCount})
                  </button>
                  <button
                    aria-pressed={batchFilter === 'unregistered'}
                    className={`nc-filter-btn ${batchFilter === 'unregistered' ? 'active' : ''}`}
                    onClick={() => setBatchFilter('unregistered')}
                  >
                    {t('numberChecker.status.notRegistered')} ({unregisteredCount})
                  </button>
                  {failedCount > 0 && (
                    <button
                      aria-pressed={batchFilter === 'failed'}
                      className={`nc-filter-btn ${batchFilter === 'failed' ? 'active' : ''}`}
                      onClick={() => setBatchFilter('failed')}
                    >
                      {t('numberChecker.status.failed')} ({failedCount})
                    </button>
                  )}
                </div>
              </div>

              <div className="nc-table-wrap" tabIndex={0} role="region" aria-label={t('numberChecker.bulk.title')}>
                <table className="nc-history-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('numberChecker.table.phone')}</th>
                      <th>{t('numberChecker.table.status')}</th>
                      <th>{t('numberChecker.table.id')}</th>
                      <th>{t('numberChecker.table.time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBatchResults.map((item, idx) => (
                      <tr key={`${item.number}-${idx}`}>
                        <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
                        <td style={{ fontWeight: 600 }}>
                          <bdi dir="ltr">+{item.number}</bdi>
                        </td>
                        <td>
                          {item.status === 'registered' ? (
                            <span className="nc-status-badge registered">
                              <CheckCircle2 size={13} /> {t('numberChecker.status.registered')}
                            </span>
                          ) : item.status === 'failed' ? (
                            <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '0.25rem' }}>
                              <span
                                className="nc-status-badge error"
                                title={item.error || t('numberChecker.toast.lookupFailed')}
                              >
                                <AlertCircle size={13} /> {t('numberChecker.status.failed')}
                              </span>
                              {item.error && (
                                <span
                                  style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--error-text)',
                                    maxWidth: '240px',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {item.error}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="nc-status-badge unregistered">
                              <XCircle size={13} /> {t('numberChecker.status.unregistered')}
                            </span>
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>
                          <bdi dir="ltr">{item.whatsappId || '-'}</bdi>
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>
                          <bdi>{timeOfDay(item.timestamp)}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
