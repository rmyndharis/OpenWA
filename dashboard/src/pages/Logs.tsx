import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, MagnifyingGlass, CircleNotch, ListBullets } from '@phosphor-icons/react';
import type { AuditLog } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useLogsQuery } from '../hooks/queries';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '../lib/utils';

const severityFilters = ['all', 'info', 'warn', 'error'] as const;

const severityStyles: Record<string, string> = {
  info: 'bg-blue-500/10 text-blue-500',
  warn: 'bg-orange-500/10 text-orange-500',
  error: 'bg-destructive/10 text-destructive',
};

export function Logs() {
  const { t } = useTranslation();
  useDocumentTitle(t('logs.title'));
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const limit = 20;

  const severityParam = activeFilter !== 'all' ? activeFilter : undefined;
  const { data, isLoading: loading } = useLogsQuery({ severity: severityParam, page, limit });
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

  const handleExportCsv = () => {
    if (filteredLogs.length === 0) return;
    const headers = ['timestamp', 'action', 'severity', 'session', 'apiKey', 'ip', 'method', 'path', 'statusCode', 'errorMessage'];
    const escape = (value: unknown): string => {
      const s = value === undefined || value === null ? '' : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = filteredLogs.map(log =>
      [log.createdAt, log.action, log.severity, log.sessionName || log.sessionId || '', log.apiKeyName || log.apiKeyId || '', log.ipAddress, log.method, log.path, log.statusCode, log.errorMessage].map(escape).join(','),
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openwa-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && logs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <CircleNotch size={48} className="animate-spin text-whatsapp-green" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="p-4 sm:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t('logs.title')}</h1>
            <p className="text-muted-foreground mt-1">{t('logs.subtitle')}</p>
          </div>
          <Button variant="secondary" onClick={handleExportCsv} disabled={filteredLogs.length === 0}>
            <Download size={16} weight="bold" />
            {t('logs.exportCsv')}
          </Button>
        </header>

        <div className="flex flex-col gap-4">
          <div className="relative">
            <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
            <Input
              placeholder={t('logs.searchPlaceholder')}
              className="pl-10 bg-muted border-none rounded-lg h-9 text-foreground placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-whatsapp-green"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            {severityFilters.map(f => (
              <Badge
                key={f}
                className={cn(
                  "cursor-pointer px-3 py-1 rounded text-xs font-medium transition-colors",
                  activeFilter === f
                    ? "bg-whatsapp-green text-white hover:bg-whatsapp-green/90"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
                onClick={() => { setActiveFilter(f); setPage(1); }}
              >
                {t(`logs.severity.${f}`)}
              </Badge>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider">
            <span className="w-[160px] shrink-0">{t('logs.columns.timestamp')}</span>
            <span className="flex-1 min-w-0">{t('logs.columns.action')}</span>
            <span className="w-[100px] shrink-0 text-center">{t('logs.columns.severity')}</span>
          </div>

          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <ListBullets size={48} weight="thin" />
              <h3 className="font-bold text-foreground text-sm">{t('logs.empty.title')}</h3>
              <p className="text-sm">{t('logs.empty.description')}</p>
            </div>
          ) : (
            <div>
              {filteredLogs.map(log => (
                  <div key={log.id} className="flex items-center px-3 py-[10px] hover:bg-muted/50 transition-colors cursor-default">
                  <span className="w-[160px] shrink-0 text-xs text-muted-foreground">{formatTimestamp(log.createdAt)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{log.action}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {[log.sessionName || log.sessionId, log.apiKeyName, log.ipAddress].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <Badge className={cn(
                    "text-[10px] font-bold uppercase tracking-wider border-none shrink-0 ml-2",
                    severityStyles[log.severity] || 'bg-muted text-muted-foreground'
                  )}>
                    {log.severity}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
              {t('common.previous')}
            </Button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i + 1).map(p => (
                <Button
                  key={p}
                  variant={p === page ? 'default' : 'ghost'}
                  size="sm"
                  className={cn("min-w-8", p === page && "bg-whatsapp-green hover:bg-whatsapp-green/90")}
                  onClick={() => setPage(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
            <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              {t('common.next')}
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
