import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Search, Filter, Loader2, FileText, AlertCircle } from 'lucide-react';
import type { AuditLog } from '../services/api';
import { auditApi } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useLogsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Logs.css';

export function Logs() {
  const { t } = useTranslation();
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

  const filteredLogs = logs.filter(log => {
    const matchesSearch =
      log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (log.errorMessage || '').toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  const totalPages = Math.ceil(total / limit);

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
    const escape = (value: unknown): string => {
      const s = value === undefined || value === null ? '' : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
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
        .map(escape)
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
  // a fetch error, fall back to exporting the rows already on screen.
  const handleExportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    const PAGE = 500;
    const CAP = 50000;
    try {
      const all: AuditLog[] = [];
      let offset = 0;
      for (;;) {
        const res = await auditApi.list({ severity: severityParam, limit: PAGE, offset });
        all.push(...res.data);
        offset += res.data.length;
        if (res.data.length < PAGE || offset >= res.total || all.length >= CAP) break;
      }
      const q = searchQuery.toLowerCase();
      const rows = q
        ? all.filter(l => l.action.toLowerCase().includes(q) || (l.errorMessage || '').toLowerCase().includes(q))
        : all;
      if (rows.length > 0) download(buildCsv(rows));
    } catch {
      if (filteredLogs.length > 0) download(buildCsv(filteredLogs)); // graceful fallback to the page
    } finally {
      setExporting(false);
    }
  };

  if (loading && logs.length === 0) {
    return (
      <div
        className="logs-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

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
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <select
            value={severityFilter}
            onChange={e => {
              setSeverityFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">{t('logs.severity.all')}</option>
            <option value="info">{t('logs.severity.info')}</option>
            <option value="warn">{t('logs.severity.warn')}</option>
            <option value="error">{t('logs.severity.error')}</option>
          </select>
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
          {filteredLogs.length === 0 ? (
            <div className="empty-table-state">
              <FileText size={48} strokeWidth={1} />
              <h3>{t('logs.empty.title')}</h3>
              <p>{t('logs.empty.description')}</p>
            </div>
          ) : (
            filteredLogs.map(log => (
              <div key={log.id} className="table-row">
                <span className="timestamp">{formatTimestamp(log.createdAt)}</span>
                <span className="action">{log.action}</span>
                <span>{log.sessionName || log.sessionId || '—'}</span>
                <span className="api-key">{log.apiKeyName || '—'}</span>
                <span className="ip">{log.ipAddress || '—'}</span>
                <span>
                  <span className={`severity-badge ${log.severity}`}>{log.severity.toUpperCase()}</span>
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
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
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
