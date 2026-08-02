import { useCallback, useState } from 'react';
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
import { BarChart3, X } from 'lucide-react';
import { useStatsMessagesQuery } from '../hooks/queries';
import type { StatsPeriod } from '../services/api';
import { colorForType, formatTick, shortChat } from '../utils/chartHelpers';
import './DashboardCharts.css';

const PERIODS: StatsPeriod[] = ['24h', '7d', '30d'];

// Numbers read as instrument readouts, not prose — same monospace rule as stat values and table
// data cells (Dashboard.css), applied to every axis tick and tooltip figure recharts renders.
const AXIS_TICK_STYLE = { fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fill: 'var(--text-secondary)' };
const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--bg-white)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
  },
  labelStyle: { color: 'var(--text-secondary)' },
  itemStyle: { color: 'var(--text-primary)' },
};



export function DashboardCharts() {
  const { t } = useTranslation();
<<<<<<< HEAD
  const [period, setPeriod] = useState<StatsPeriod>('7d');
  const [activeType, setActiveType] = useState<string | null>(null);

  const handleSliceClick = useCallback((entry: { name: string }) => {
    if (!entry.name) return;
    setActiveType(prev => (prev === entry.name ? null : entry.name));
  }, []);
=======
  const [period, setPeriod] = useState<StatsPeriod>('24h');
>>>>>>> upstream/main
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
  const topChats = (data?.topChats ?? [])
    .slice(0, 8)
    .map(c => ({ name: c.chatName || shortChat(c.chatId), count: c.messageCount }));
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
                <XAxis dataKey="label" tick={AXIS_TICK_STYLE} />
                <YAxis allowDecimals={false} tick={AXIS_TICK_STYLE} />
                <Tooltip {...TOOLTIP_STYLE} />
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
            <h3 className="chart-type-title">
              {t('dashboard.charts.byType')}
              {activeType && (
                <button
                  className="chart-filter-clear"
                  onClick={() => setActiveType(null)}
                  title={t('common.clear')}
                  type="button"
                >
                  <X size={14} />
                </button>
              )}
            </h3>
            {byType.length === 0 ? (
              <div className="charts-empty small">{t('dashboard.charts.empty')}</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={byType}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                    onClick={(entry: { name?: string }) => handleSliceClick(entry as { name: string })}
                    style={{ cursor: 'pointer' }}
                  >
                    {byType.map(entry => (
                      <Cell
                        key={entry.name}
                        fill={colorForType(entry.name)}
                        onClick={() => handleSliceClick(entry)}
                        style={{ cursor: 'pointer' }}
                      />
                    ))}
                  </Pie>
                  <Tooltip {...TOOLTIP_STYLE} />
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
                  <XAxis type="number" allowDecimals={false} tick={AXIS_TICK_STYLE} />
                  <YAxis type="category" dataKey="name" width={120} tick={AXIS_TICK_STYLE} />
                  <Tooltip {...TOOLTIP_STYLE} />
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
