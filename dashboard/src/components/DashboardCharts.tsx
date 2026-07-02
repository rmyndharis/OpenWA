import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import { useStatsMessagesQuery } from '../hooks/queries';
import type { StatsPeriod } from '../services/api';
import './DashboardCharts.css';

const PERIODS: StatsPeriod[] = ['24h', '7d', '30d'];

// Stable, distinct color per message type (recharts needs literal colors). Keyed by type name —
// not array index — so two types can never share a color, and a slice keeps its color even when the
// set of present types changes between requests. Covers every type mapMessageType() can emit.
const TYPE_COLORS: Record<string, string> = {
  text: '#25d366',
  image: '#3b82f6',
  contact: '#a855f7',
  document: '#f59e0b',
  audio: '#06b6d4',
  voice: '#ec4899',
  video: '#14b8a6',
  sticker: '#ef4444',
  location: '#84cc16',
  revoked: '#f43f5e',
  masked: '#8b5cf6',
  unknown: '#64748b',
};

// Deterministic fallback for any unmapped type, so its color is stable across renders.
const FALLBACK_COLORS = ['#0ea5e9', '#d946ef', '#f97316', '#10b981', '#6366f1', '#eab308'];
function colorForType(name: string): string {
  if (TYPE_COLORS[name]) return TYPE_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// '2026-06-24 14:00:00' (hour buckets) → '14:00'; '2026-06-24' (day buckets) → '06-24'.
function formatTick(ts: string, period: StatsPeriod): string {
  return period === '24h' ? ts.slice(11, 16) : ts.slice(5);
}

// WhatsApp ids look like '62812...@c.us' / '...@g.us' / '...@lid' — show just the local part.
function shortChat(chatId: string): string {
  return chatId.split('@')[0] || chatId;
}

export function DashboardCharts() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<StatsPeriod>('7d');
  const { data, isLoading, isError, error } = useStatsMessagesQuery(period);

  // Non-admin keys 403 on /stats/messages → hide the section entirely. Any OTHER error (e.g. a
  // server 500) is a real fault: surface a small notice below instead of silently vanishing, which
  // is what masked the #488 stats crash and made the whole chart "disappear" with no explanation.
  const forbidden = (error as (Error & { status?: number }) | null)?.status === 403;
  if (isError && forbidden) return null;

  const timeSeries = (data?.timeSeries ?? []).map(p => ({ ...p, label: formatTick(p.timestamp, period) }));
  const byType = Object.entries(data?.byType ?? {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const topChats = (data?.topChats ?? []).slice(0, 8).map(c => ({ name: c.chatName || shortChat(c.chatId), count: c.messageCount }));
  const hasData = timeSeries.length > 0 || byType.length > 0 || topChats.length > 0;

  return (
    <section className="dashboard-charts">
      <div className="charts-header">
        <div className="charts-title">
          <BarChart3 size={18} />
          <h2>{t('dashboard.charts.title')}</h2>
        </div>
        <div className="period-toggle" role="group" aria-label={t('dashboard.charts.title')}>
          {PERIODS.map(p => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              className={`period-tab ${period === p ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {t(`dashboard.charts.period.${p}`)}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="charts-empty">{t('common.loading')}</div>
      ) : isError ? (
        <div className="charts-empty">{t('dashboard.charts.error')}</div>
      ) : !hasData ? (
        <div className="charts-empty">{t('dashboard.charts.empty')}</div>
      ) : (
        <div className="charts-grid">
          <div className="chart-card chart-wide">
            <h3>{t('dashboard.charts.overTime')}</h3>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={timeSeries} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#25d366" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#25d366" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gReceived" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                <Tooltip />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="sent"
                  name={t('dashboard.charts.sent')}
                  stroke="#25d366"
                  fill="url(#gSent)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="received"
                  name={t('dashboard.charts.received')}
                  stroke="#3b82f6"
                  fill="url(#gReceived)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card">
            <h3>{t('dashboard.charts.byType')}</h3>
            {byType.length === 0 ? (
              <div className="charts-empty small">{t('dashboard.charts.empty')}</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={byType} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {byType.map(entry => (
                      <Cell key={entry.name} fill={colorForType(entry.name)} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="chart-card">
            <h3>{t('dashboard.charts.topChats')}</h3>
            {topChats.length === 0 ? (
              <div className="charts-empty small">{t('dashboard.charts.empty')}</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={topChats} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={120}
                    tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
                  />
                  <Tooltip />
                  <Bar dataKey="count" name={t('dashboard.charts.messages')} fill="#25d366" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
