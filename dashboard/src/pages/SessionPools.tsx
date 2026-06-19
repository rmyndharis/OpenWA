import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Trash2, Activity, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import { sessionPoolApi, type SessionPoolItem, type PoolStatus } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import './SessionPools.css';

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'ready' ? 'var(--color-success, #22c55e)' :
    status === 'disconnected' || status === 'failed' ? 'var(--color-error, #ef4444)' :
    'var(--color-warning, #f59e0b)';
  return <span className="sp-dot" style={{ background: color }} title={status} />;
}

function TrendArrow({ trend }: { trend: string }) {
  if (trend === 'improving') return <span title="Improving">↑</span>;
  if (trend === 'declining') return <span title="Declining">↓</span>;
  if (trend === 'critical') return <span title="Critical">⚠</span>;
  return <span title="Stable">→</span>;
}

export function SessionPools() {
  const { t } = useTranslation();
  useDocumentTitle('Session Pools');
  const toast = useToast();

  const [pools, setPools] = useState<SessionPoolItem[]>([]);
  const [expandedPool, setExpandedPool] = useState<string | null>(null);
  const [poolStatus, setPoolStatus] = useState<Record<string, PoolStatus>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const fetchPools = useCallback(async () => {
    try {
      setLoading(true);
      const data = await sessionPoolApi.list();
      setPools(data);
    } catch {
      toast.error('Failed to load session pools', '');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void fetchPools(); }, [fetchPools]);

  const loadPoolStatus = useCallback(async (poolId: string) => {
    try {
      const status = await sessionPoolApi.getStatus(poolId);
      setPoolStatus(prev => ({ ...prev, [poolId]: status }));
    } catch {
      // ignore
    }
  }, []);

  const handleExpand = useCallback((poolId: string) => {
    const next = expandedPool === poolId ? null : poolId;
    setExpandedPool(next);
    if (next) void loadPoolStatus(next);
  }, [expandedPool, loadPoolStatus]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await sessionPoolApi.create({ name: newName.trim() });
      toast.success('Pool created', '');
      setNewName('');
      setShowCreate(false);
      void fetchPools();
    } catch {
      toast.error('Failed to create pool', '');
    } finally {
      setCreating(false);
    }
  }, [newName, toast, fetchPools]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await sessionPoolApi.remove(id);
      toast.success('Pool deleted', '');
      void fetchPools();
    } catch {
      toast.error('Failed to delete pool', '');
    }
  }, [toast, fetchPools]);

  const handleFailoverTest = useCallback(async (poolId: string, sessionId: string) => {
    try {
      const result = await sessionPoolApi.testFailover(poolId, sessionId);
      toast.success('Failover complete', `Promoted: ${result.promotedSessionId}`);
      void loadPoolStatus(poolId);
    } catch {
      toast.error('Failover failed', '');
    }
  }, [toast, loadPoolStatus]);

  return (
    <div className="sp-page">
      <PageHeader
        title="Session Pools"
        subtitle="Hot-standby pools with automatic failover"
        actions={
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> New Pool
          </button>
        }
      />

      {showCreate && (
        <div className="sp-create-bar">
          <input
            className="sp-input"
            placeholder="Pool name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void handleCreate()}
          />
          <button className="btn btn-primary" disabled={creating} onClick={() => void handleCreate()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
        </div>
      )}

      {loading ? (
        <div className="sp-loading"><RefreshCw className="animate-spin" size={24} /></div>
      ) : pools.length === 0 ? (
        <div className="sp-empty">
          <Activity size={40} />
          <p>No session pools yet. Create one to set up hot-standby failover.</p>
        </div>
      ) : (
        <div className="sp-list">
          {pools.map(pool => {
            const status = poolStatus[pool.id];
            const isExpanded = expandedPool === pool.id;
            return (
              <div key={pool.id} className="sp-card">
                <div className="sp-card-header" onClick={() => handleExpand(pool.id)}>
                  <div className="sp-card-title">
                    <span className="sp-name">{pool.name}</span>
                    <span className="sp-meta">
                      {pool.productionSessionIds.length} production · {pool.standbySessionIds.length} standby
                    </span>
                  </div>
                  <div className="sp-card-actions">
                    {pool.autoFailover && <span className="sp-badge sp-badge-green"><CheckCircle size={12} /> Auto-failover</span>}
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={e => { e.stopPropagation(); void handleDelete(pool.id); }}
                      title="Delete pool"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="sp-card-body">
                    {status ? (
                      <>
                        <div className="sp-section">
                          <h4>Production Sessions</h4>
                          {status.production.length === 0
                            ? <p className="sp-empty-msg">No production sessions assigned</p>
                            : status.production.map(s => (
                              <div key={s.id} className="sp-session-row">
                                <StatusDot status={s.status} />
                                <span>{s.name}</span>
                                <span className="sp-session-status">{s.status}</span>
                                {(s.status === 'disconnected' || s.status === 'failed') && (
                                  <button
                                    className="btn btn-warning btn-xs"
                                    onClick={() => void handleFailoverTest(pool.id, s.id)}
                                  >
                                    Failover
                                  </button>
                                )}
                              </div>
                            ))
                          }
                        </div>

                        <div className="sp-section">
                          <h4>Standby Sessions</h4>
                          {status.standby.length === 0
                            ? <p className="sp-empty-msg">No standby sessions. Target: {pool.targetStandbyCount}</p>
                            : status.standby.map(s => (
                              <div key={s.id} className="sp-session-row">
                                <StatusDot status={s.status} />
                                <span>{s.name}</span>
                                <span className="sp-session-status">{s.status}</span>
                              </div>
                            ))
                          }
                        </div>

                        {status.failoverHistory.length > 0 && (
                          <div className="sp-section">
                            <h4>Recent Failovers</h4>
                            {status.failoverHistory.slice(0, 5).map((r, i) => (
                              <div key={i} className="sp-failover-row">
                                <AlertTriangle size={12} className="sp-failover-icon" />
                                <span>
                                  {r.failedSessionId.slice(0, 8)}… → {r.promotedSessionId.slice(0, 8)}…
                                </span>
                                <span className="sp-time">
                                  <Clock size={10} /> {new Date(r.timestamp).toLocaleString()}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="sp-loading"><RefreshCw className="animate-spin" size={16} /> Loading status…</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
