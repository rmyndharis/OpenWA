import { useState, useRef, useEffect } from 'react';
import { Upload, RefreshCw, Search, MessageSquare, BarChart2, ToggleLeft, Trash2, Loader2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiCatalogApi, sessionApi, type CatalogItem, type CatalogAnswer } from '../services/api';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './AiCatalog.css';

export function AiCatalog() {
  useDocumentTitle('AI Catalog');
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [askQuestion, setAskQuestion] = useState('');
  const [searchResults, setSearchResults] = useState<CatalogItem[] | null>(null);
  const [answerResult, setAnswerResult] = useState<CatalogAnswer | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: sessions = [] } = useQuery({ queryKey: ['sessions'], queryFn: sessionApi.list });
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['ai-catalog', sessionId],
    queryFn: () => aiCatalogApi.list(sessionId),
    enabled: !!sessionId,
  });
  const { data: stats } = useQuery({
    queryKey: ['ai-catalog-stats', sessionId],
    queryFn: () => aiCatalogApi.stats(sessionId),
    enabled: !!sessionId,
  });

  useEffect(() => {
    if (!sessionId && sessions.length) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const importCsvMutation = useMutation({
    mutationFn: (file: File) => aiCatalogApi.importCsv(sessionId, file),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ['ai-catalog', sessionId] });
      qc.invalidateQueries({ queryKey: ['ai-catalog-stats', sessionId] });
      setToast({ type: 'success', msg: `Imported: ${r.created} created, ${r.updated} updated${r.errors.length ? ` (${r.errors.length} errors)` : ''}` });
    },
    onError: () => setToast({ type: 'error', msg: 'Import failed' }),
  });

  const reEmbedMutation = useMutation({
    mutationFn: () => aiCatalogApi.reEmbed(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-catalog-stats', sessionId] });
      setToast({ type: 'success', msg: 'Re-embedding complete' });
    },
    onError: () => setToast({ type: 'error', msg: 'Re-embed failed' }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, available }: { id: string; available: boolean }) =>
      aiCatalogApi.update(sessionId, id, { available }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-catalog', sessionId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => aiCatalogApi.delete(sessionId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-catalog', sessionId] });
      qc.invalidateQueries({ queryKey: ['ai-catalog-stats', sessionId] });
    },
  });

  const [isSearching, setIsSearching] = useState(false);
  const [isAsking, setIsAsking] = useState(false);

  async function handleSearch() {
    if (!searchQuery.trim() || !sessionId) return;
    setIsSearching(true);
    try {
      const r = await aiCatalogApi.search(sessionId, searchQuery);
      setSearchResults(r);
    } catch { setToast({ type: 'error', msg: 'Search failed' }); }
    finally { setIsSearching(false); }
  }

  async function handleAsk() {
    if (!askQuestion.trim() || !sessionId) return;
    setIsAsking(true);
    try {
      const r = await aiCatalogApi.ask(sessionId, askQuestion);
      setAnswerResult(r);
    } catch { setToast({ type: 'error', msg: 'Q&A failed' }); }
    finally { setIsAsking(false); }
  }

  return (
    <div className="ai-catalog-page">
      <PageHeader title="AI Catalog" subtitle="Product catalog with semantic search and AI Q&A" />

      {toast && <div className={`catalog-toast ${toast.type}`}>{toast.msg}</div>}

      <div className="catalog-controls">
        <select value={sessionId} onChange={e => setSessionId(e.target.value)} className="session-select">
          {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <button onClick={() => fileRef.current?.click()} disabled={!sessionId || importCsvMutation.isPending} className="btn-primary">
          <Upload size={16} /> Import CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={e => {
          const f = e.target.files?.[0]; if (f) importCsvMutation.mutate(f);
          e.target.value = '';
        }} />

        <button onClick={() => reEmbedMutation.mutate()} disabled={!sessionId || reEmbedMutation.isPending} className="btn-secondary">
          {reEmbedMutation.isPending ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />} Re-embed
        </button>
      </div>

      {stats && (
        <div className="catalog-stats">
          <div className="stat-card"><BarChart2 size={20} /><span className="stat-val">{stats.total}</span><span className="stat-label">Total Items</span></div>
          <div className="stat-card"><RefreshCw size={20} /><span className="stat-val">{stats.embedded}</span><span className="stat-label">Embedded</span></div>
          <div className="stat-card"><ToggleLeft size={20} /><span className="stat-val">{stats.available}</span><span className="stat-label">Available</span></div>
        </div>
      )}

      <div className="catalog-search-panel">
        <div className="search-row">
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Semantic search…" className="search-input" />
          <button onClick={handleSearch} disabled={isSearching || !sessionId} className="btn-primary">
            {isSearching ? <Loader2 size={16} className="spin" /> : <Search size={16} />} Search
          </button>
        </div>
        {searchResults && (
          <div className="search-results">
            <strong>Top matches ({searchResults.length})</strong>
            {searchResults.map(i => (
              <div key={i.id} className="search-result-item">
                <span className="item-name">{i.name}</span>
                <span className="item-sku">{i.sku}</span>
                <span className="item-price">{i.price ? `${i.price} ${i.currency ?? ''}` : '—'}</span>
              </div>
            ))}
          </div>
        )}

        <div className="search-row" style={{ marginTop: '0.75rem' }}>
          <input value={askQuestion} onChange={e => setAskQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAsk()} placeholder="Ask a product question…" className="search-input" />
          <button onClick={handleAsk} disabled={isAsking || !sessionId} className="btn-primary">
            {isAsking ? <Loader2 size={16} className="spin" /> : <MessageSquare size={16} />} Ask
          </button>
        </div>
        {answerResult && (
          <div className={`answer-panel confidence-${answerResult.confidence}`}>
            <div className="answer-confidence">{answerResult.confidence}</div>
            <p className="answer-text">{answerResult.answer}</p>
          </div>
        )}
      </div>

      <div className="catalog-table-wrap">
        {isLoading ? <Loader2 className="spin center" /> : (
          <table className="catalog-table">
            <thead>
              <tr>
                <th>SKU</th><th>Name</th><th>Price</th><th>Category</th><th>Stock</th><th>Available</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={7} className="empty-row">No items yet. Import a CSV to get started.</td></tr>
              )}
              {items.map(item => (
                <tr key={item.id}>
                  <td><code>{item.sku}</code></td>
                  <td>{item.name}</td>
                  <td>{item.price ? `${item.price} ${item.currency ?? ''}` : '—'}</td>
                  <td>{item.category ?? '—'}</td>
                  <td><span className={`stock-badge ${item.stock ?? 'unknown'}`}>{item.stock ?? '—'}</span></td>
                  <td>
                    <button
                      className={`toggle-btn ${item.available ? 'on' : 'off'}`}
                      onClick={() => toggleMutation.mutate({ id: item.id, available: !item.available })}
                    >{item.available ? 'On' : 'Off'}</button>
                  </td>
                  <td>
                    <button className="icon-btn danger" onClick={() => deleteMutation.mutate(item.id)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
