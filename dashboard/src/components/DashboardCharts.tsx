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

// Distinct, theme-agnostic palette for the donut slices (recharts needs literal colors).
const TYPE_COLORS = ['#25d366', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#64748b'];

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
  const { data, isLoading, isError } = useStatsMessagesQuery(period);

  // Non-admin keys 403 on /stats/messages; hide the section rather than show a broken card.
  if (isError) return null;

  const timeSeries = (data?.timeSeries ?? []).map(p => ({ ...p, label: formatTick(p.timestamp, period) }));
  const byType = Object.entries(data?.byType ?? {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const topChats = (data?.topChats ?? []).slice(0, 8).map(c => ({ name: shortChat(c.chatId), count: c.messageCount }));
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
                    {byType.map((entry, i) => (
                      <Cell key={entry.name} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />
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
