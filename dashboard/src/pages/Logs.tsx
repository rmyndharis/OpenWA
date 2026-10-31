import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Search, Filter, Loader2, FileText, AlertCircle } from 'lucide-react';
import type { AuditLog } from '../services/api';
import { auditApi } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useLogsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { CustomSelect } from '../components/CustomSelect';
import { pageWindow } from '../utils/pageWindow';
import { fetchAllPages } from '../utils/fetchAllPages';
import { escapeCsvCell } from '../utils/csv';
import './Logs.css';

export function Logs() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('logs.title'));
  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const limit = 20;

  const severityParam = severityFilter !== 'all' ? severityFilter : undefined;
  const { data, isLoading: loading, isError: logsError } = useLogsQuery({ severity: severityParam, page, limit });
  const logs: AuditLog[] = data?.data ?? [];
  const total: number = data?.total ?? 0;

  // Trimmed once, so the table, its empty state and the export agree on whether a search is active.
  const q = searchQuery.trim().toLowerCase();
  const matchesSearch = (log: AuditLog) =>
    log.action.toLowerCase().includes(q) || (log.errorMessage || '').toLowerCase().includes(q);
  const filteredLogs = logs.filter(matchesSearch);

  const totalPages = Math.ceil(total / limit);
  // Distinguish "filters matched nothing on this page" from "there are no logs at all": the search
  // box only filters the fetched page (the API has no text search), so a non-match here must not
  // read as "no such event exists" while more pages may hold it.
  const hasSearch = q !== '';
  // Severity is enforced SERVER-SIDE (the query carries it): an empty result there means no logs
  // match at all, which deserves different guidance than the page-local search box.
  const hasSeverityFilter = severityFilter !== 'all';

  const formatTimestamp = (date: string) => new Date(date).toLocaleString();

  const buildCsv = (rows: AuditLog[]): string => {
    const headers = [
      'timestamp',
      'action',
      'severity',
      'session',
      'apiKey',
      'ip',
      'method',
      'path',
      'statusCode',
      'errorMessage',
    ];
    const lines = rows.map(log =>
      [
        log.createdAt,
        log.action,
        log.severity,
        log.sessionName || log.sessionId || '',
        log.apiKeyName || log.apiKeyId || '',
        log.ipAddress,
        log.method,
        log.path,
        log.statusCode,
        log.errorMessage,
      ]
        .map(escapeCsvCell)
        .join(','),
    );
    return [headers.join(','), ...lines].join('\n');
  };

  const download = (csv: string) => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openwa-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export the WHOLE audit history (honouring the active severity filter + search), not just the
  // current page — paginate through the API up to a safety cap so a huge table can't OOM the tab. On
  // a fetch error, report it and download nothing: the rows on screen would pass for the full export.
  const handleExportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { items, truncated, throttled } = await fetchAllPages<AuditLog>((limit, offset) =>
        auditApi.list({ severity: severityParam, limit, offset }),
      );
      // The walk pages by offset over a live table, newest first: a row written between two pages pushes
      // the older ones down, so the next page starts with one already fetched. Keep each id once.
      const all = [...new Map(items.map(log => [log.id, log])).values()];
      const rows = all.filter(matchesSearch);
      // Either stop keeps the newest rows (the API orders newest first); older ones are missing. A
      // narrower filter gets past the cap, only waiting gets past the throttle. The count follows the UI
      // language, not the browser's locale, so it reads right inside the sentence.
      const rowCount = all.length.toLocaleString(i18n.resolvedLanguage);
      if (rows.length === 0) {
        // After a truncated walk the older rows were never searched, so the message must not read as
        // a verdict on the whole history.
        if (truncated) toast.warning(t('logs.exportNoMatchesTruncated', { rows: rowCount }));
        else toast.info(t('logs.exportNoMatches'));
        return;
      }
      download(buildCsv(rows));
      if (truncated) {
        toast.warning(t(throttled ? 'logs.exportThrottled' : 'logs.exportTruncated', { rows: rowCount }));
      }
    } catch (err) {
      toast.error(t('logs.exportFailed'), err instanceof Error ? err.message : undefined);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="logs-page">
      <PageHeader
        title={t('logs.title')}
        subtitle={t('logs.subtitle')}
        actions={
          <button className="btn-secondary" onClick={() => void handleExportCsv()} disabled={exporting || total === 0}>
            {exporting ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
            {t('logs.exportCsv')}
          </button>
        }
      />

      {logsError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('logs.searchPlaceholder')}
            value={searchQuery}
            onChange={e => {
              setSearchQuery(e.target.value);
              // A new query invalidates the current page position, like the severity filter below.
              setPage(1);
            }}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <CustomSelect
            value={severityFilter}
            onChange={value => {
              setSeverityFilter(value);
              setPage(1);
            }}
            options={[
              { value: 'all', label: t('logs.severity.all') },
              { value: 'info', label: t('logs.severity.info') },
              { value: 'warn', label: t('logs.severity.warn') },
              { value: 'error', label: t('logs.severity.error') },
            ]}
            ariaLabel={t('logs.columns.severity')}
          />
        </div>
      </div>

      <div className="logs-table-container">
        <div className="logs-table">
          <div className="table-row header">
            <span>{t('logs.columns.timestamp')}</span>
            <span>{t('logs.columns.action')}</span>
            <span>{t('logs.columns.session')}</span>
            <span>{t('logs.columns.apiKey')}</span>
            <span>{t('logs.columns.ip')}</span>
            <span>{t('logs.columns.severity')}</span>
          </div>
          {/* The spinner stays inside the table: a search or severity change switches to a page that
              may not be cached, and replacing the whole page would unmount the search box mid-typing. */}
          {loading && logs.length === 0 ? (
            <div className="empty-table-state">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : logsError && logs.length === 0 ? (
            // Nothing was read, so no "no logs" copy: the banner above reports the failure on its own.
            <div className="empty-table-state">
              <AlertCircle size={32} />
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="empty-table-state">
              <FileText size={48} strokeWidth={1} />
              {hasSeverityFilter && !hasSearch ? (
                <>
                  <h3>{t('logs.empty.title')}</h3>
                  <p>{t('logs.empty.filteredServerDescription')}</p>
                </>
              ) : hasSearch ? (
                <>
                  <h3>{t('logs.empty.filteredTitle')}</h3>
                  <p>{t('logs.empty.filteredDescription')}</p>
                </>
              ) : (
                <>
                  <h3>{t('logs.empty.title')}</h3>
                  <p>{t('logs.empty.description')}</p>
                </>
              )}
            </div>
          ) : (
            filteredLogs.map(log => (
              <div key={log.id} className="table-row">
                <span className="timestamp">{formatTimestamp(log.createdAt)}</span>
                <span className="action">
                  {log.action}
                  {log.errorMessage && <span className="log-message">{log.errorMessage}</span>}
                </span>
                <span>{log.sessionName || log.sessionId || '—'}</span>
                <span className="api-key">{log.apiKeyName || '—'}</span>
                <span className="ip">{log.ipAddress || '—'}</span>
                <span>
                  <span className={`severity-badge ${log.severity}`}>{t(`logs.severity.${log.severity}`)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>
            {t('common.previous')}
          </button>
          <span className="page-numbers">
            {pageWindow(page, totalPages).map(p => (
              <button key={p} className={p === page ? 'active' : ''} onClick={() => setPage(p)}>
                {p}
              </button>
            ))}
          </span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}
    </div>
  );
}
