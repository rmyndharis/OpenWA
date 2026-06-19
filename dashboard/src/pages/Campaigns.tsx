import { useState, useEffect } from 'react';
import { Plus, Zap, AlertTriangle, CheckCircle, Info, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { campaignOptimizerApi, sessionApi, type Campaign, type CampaignOptimization } from '../services/api';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './Campaigns.css';

type Tab = 'overview' | 'insights';

function severityIcon(s: string) {
  if (s === 'high') return <AlertTriangle size={14} className="sev-high" />;
  if (s === 'medium') return <Info size={14} className="sev-medium" />;
  return <CheckCircle size={14} className="sev-low" />;
}

function PerformanceScore({ score }: { score: number }) {
  const color = score >= 70 ? '#16a34a' : score >= 40 ? '#d97706' : '#dc2626';
  return (
    <div className="perf-score" style={{ '--score-color': color } as React.CSSProperties}>
      <span className="perf-num" style={{ color }}>{score}</span>
      <span className="perf-label">/100</span>
    </div>
  );
}

export function Campaigns() {
  useDocumentTitle('Campaign Optimizer');
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [statsForm, setStatsForm] = useState<Partial<Campaign>>({});
  const [editingStats, setEditingStats] = useState(false);
  const [expandedRec, setExpandedRec] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const { data: sessions = [] } = useQuery({ queryKey: ['sessions'], queryFn: sessionApi.list });
  const { data: campaigns = [], isLoading: loadingCampaigns } = useQuery({
    queryKey: ['campaigns', sessionId],
    queryFn: () => campaignOptimizerApi.listCampaigns(sessionId),
    enabled: !!sessionId,
  });
  const { data: optimization, isLoading: loadingOpt } = useQuery({
    queryKey: ['campaign-opt', selectedCampaignId],
    queryFn: () => campaignOptimizerApi.getOptimization(sessionId, selectedCampaignId),
    enabled: !!sessionId && !!selectedCampaignId,
  });

  const selectedCampaign = campaigns.find(c => c.id === selectedCampaignId);

  useEffect(() => {
    if (!sessionId && sessions.length) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);

  useEffect(() => {
    if (!selectedCampaignId && campaigns.length) setSelectedCampaignId(campaigns[0].id);
  }, [campaigns, selectedCampaignId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const createMutation = useMutation({
    mutationFn: () => campaignOptimizerApi.createCampaign(sessionId, newName),
    onSuccess: c => {
      qc.invalidateQueries({ queryKey: ['campaigns', sessionId] });
      setNewName(''); setShowCreate(false);
      setSelectedCampaignId(c.id);
      setToast({ type: 'success', msg: `Campaign "${c.name}" created` });
    },
    onError: () => setToast({ type: 'error', msg: 'Create failed' }),
  });

  const updateStatsMutation = useMutation({
    mutationFn: () => campaignOptimizerApi.updateStats(sessionId, selectedCampaignId, statsForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns', sessionId] });
      setEditingStats(false);
      setToast({ type: 'success', msg: 'Stats updated' });
    },
    onError: () => setToast({ type: 'error', msg: 'Update failed' }),
  });

  const optimizeMutation = useMutation({
    mutationFn: () => campaignOptimizerApi.optimize(sessionId, selectedCampaignId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaign-opt', selectedCampaignId] });
      setTab('insights');
      setToast({ type: 'success', msg: 'Analysis complete' });
    },
    onError: () => setToast({ type: 'error', msg: 'Optimization failed — check LLM configuration' }),
  });

  const applyMutation = useMutation({
    mutationFn: (index: number) => campaignOptimizerApi.applyRecommendation(sessionId, selectedCampaignId, index),
    onSuccess: r => {
      if (r) setToast({ type: 'success', msg: `Recommendation: "${r.action}"` });
    },
  });

  function startEditStats() {
    if (!selectedCampaign) return;
    setStatsForm({
      enrollmentCount: selectedCampaign.enrollmentCount,
      completionRate: selectedCampaign.completionRate,
      unsubscribeRate: selectedCampaign.unsubscribeRate,
      replyRate: selectedCampaign.replyRate,
    });
    setEditingStats(true);
  }

  return (
    <div className="campaigns-page">
      <PageHeader title="Campaign Optimizer" subtitle="AI-powered drip campaign insights and recommendations" />

      {toast && <div className={`camp-toast ${toast.type}`}>{toast.msg}</div>}

      <div className="camp-controls">
        <select value={sessionId} onChange={e => { setSessionId(e.target.value); setSelectedCampaignId(''); }} className="session-select">
          {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <button onClick={() => setShowCreate(v => !v)} className="btn-primary">
          <Plus size={16} /> New Campaign
        </button>
      </div>

      {showCreate && (
        <div className="create-form">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Campaign name" className="text-input" onKeyDown={e => e.key === 'Enter' && newName.trim() && createMutation.mutate()} />
          <button onClick={() => createMutation.mutate()} disabled={!newName.trim() || createMutation.isPending} className="btn-primary">
            {createMutation.isPending ? <Loader2 size={14} className="spin" /> : 'Create'}
          </button>
          <button onClick={() => setShowCreate(false)} className="btn-ghost">Cancel</button>
        </div>
      )}

      <div className="camp-layout">
        <aside className="camp-sidebar">
          {loadingCampaigns ? <Loader2 className="spin" /> : campaigns.map(c => (
            <button
              key={c.id}
              className={`camp-list-item ${c.id === selectedCampaignId ? 'active' : ''}`}
              onClick={() => { setSelectedCampaignId(c.id); setTab('overview'); }}
            >
              <span className="camp-name">{c.name}</span>
              {c.performanceScore !== undefined && <PerformanceScore score={c.performanceScore} />}
            </button>
          ))}
          {!loadingCampaigns && campaigns.length === 0 && (
            <p className="empty-hint">No campaigns yet.</p>
          )}
        </aside>

        <main className="camp-main">
          {!selectedCampaign ? (
            <div className="empty-state">Select or create a campaign to begin.</div>
          ) : (
            <>
              <div className="camp-header">
                <h2>{selectedCampaign.name}</h2>
                <div className="camp-actions">
                  <button onClick={startEditStats} className="btn-ghost">Edit Stats</button>
                  <button onClick={() => optimizeMutation.mutate()} disabled={optimizeMutation.isPending} className="btn-primary">
                    {optimizeMutation.isPending ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} Analyze
                  </button>
                </div>
              </div>

              {editingStats && (
                <div className="stats-edit-form">
                  {(['enrollmentCount', 'completionRate', 'unsubscribeRate', 'replyRate'] as const).map(f => (
                    <label key={f}>
                      <span>{f}</span>
                      <input type="number" value={(statsForm[f] as number) ?? ''} onChange={e => setStatsForm(s => ({ ...s, [f]: parseFloat(e.target.value) || 0 }))} className="text-input small" />
                    </label>
                  ))}
                  <button onClick={() => updateStatsMutation.mutate()} disabled={updateStatsMutation.isPending} className="btn-primary">Save</button>
                  <button onClick={() => setEditingStats(false)} className="btn-ghost">Cancel</button>
                </div>
              )}

              <div className="camp-kpis">
                <div className="kpi"><span className="kpi-val">{selectedCampaign.enrollmentCount}</span><span className="kpi-label">Enrollments</span></div>
                <div className="kpi"><span className="kpi-val">{selectedCampaign.completionRate?.toFixed(1) ?? '—'}%</span><span className="kpi-label">Completion</span></div>
                <div className="kpi"><span className="kpi-val">{selectedCampaign.unsubscribeRate?.toFixed(1) ?? '—'}%</span><span className="kpi-label">Unsubscribe</span></div>
                <div className="kpi"><span className="kpi-val">{selectedCampaign.replyRate?.toFixed(1) ?? '—'}%</span><span className="kpi-label">Reply Rate</span></div>
                {selectedCampaign.performanceScore !== undefined && (
                  <div className="kpi"><PerformanceScore score={selectedCampaign.performanceScore} /><span className="kpi-label">Score</span></div>
                )}
              </div>

              <div className="camp-tabs">
                <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
                <button className={tab === 'insights' ? 'active' : ''} onClick={() => setTab('insights')}>
                  Insights {optimization ? `(${(optimization as CampaignOptimization).insights?.length ?? 0})` : ''}
                </button>
              </div>

              {tab === 'overview' && (
                <div className="camp-overview">
                  <p className="overview-hint">Run <strong>Analyze</strong> to get AI-powered insights and recommendations from your campaign data.</p>
                  {selectedCampaign.stepFunnel && (() => {
                    const funnel: number[] = JSON.parse(selectedCampaign.stepFunnel!);
                    return (
                      <div className="funnel">
                        <h4>Step Funnel</h4>
                        {funnel.map((pct, i) => (
                          <div key={i} className="funnel-bar">
                            <span className="funnel-label">Step {i + 1}</span>
                            <div className="funnel-track"><div className="funnel-fill" style={{ width: `${pct}%` }} /></div>
                            <span className="funnel-pct">{pct}%</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {tab === 'insights' && (
                <div className="insights-panel">
                  {loadingOpt && <Loader2 className="spin center" />}
                  {!loadingOpt && !optimization && (
                    <p className="empty-hint">No insights yet. Click <strong>Analyze</strong> to generate.</p>
                  )}
                  {optimization && (() => {
                    const opt = optimization as CampaignOptimization;
                    return (
                      <>
                        <section>
                          <h4>Insights</h4>
                          {opt.insights?.map((ins, i) => (
                            <div key={i} className="insight-card">
                              <div className="insight-header">{severityIcon(ins.severity)}<span>{ins.issue}</span><span className="sev-badge sev-{ins.severity}">{ins.severity}</span></div>
                              <div className="insight-metric">{ins.metric}</div>
                            </div>
                          ))}
                        </section>

                        <section>
                          <h4>Recommendations</h4>
                          {opt.recommendations?.map((rec, i) => (
                            <div key={i} className="rec-card">
                              <button className="rec-header" onClick={() => setExpandedRec(expandedRec === i ? null : i)}>
                                <span className="rec-priority">#{rec.priority}</span>
                                <span className="rec-action">{rec.action}</span>
                                {expandedRec === i ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                <button className="apply-btn" onClick={e => { e.stopPropagation(); applyMutation.mutate(i); }}>Apply</button>
                              </button>
                              {expandedRec === i && (
                                <div className="rec-body">
                                  <p><strong>Why:</strong> {rec.rationale}</p>
                                  <p><strong>Impact:</strong> {rec.expectedImpact}</p>
                                </div>
                              )}
                            </div>
                          ))}
                        </section>

                        {opt.abtestSuggestion && (
                          <section className="abtest-panel">
                            <h4>A/B Test Suggestion</h4>
                            <div className="abtest-card">
                              <div className="abtest-step">Step {opt.abtestSuggestion.stepIndex + 1}</div>
                              <div className="abtest-variants">
                                <div className="variant"><strong>A:</strong> {opt.abtestSuggestion.variantA}</div>
                                <div className="variant"><strong>B:</strong> {opt.abtestSuggestion.variantB}</div>
                              </div>
                              <p className="abtest-hypothesis"><em>{opt.abtestSuggestion.hypothesis}</em></p>
                            </div>
                          </section>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
