import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, History, Search, UserRoundSearch } from 'lucide-react';
import { useToast } from '../hooks/useToast';
import {
  workflowHubApi,
  type WorkflowRecord,
  type WorkflowTalentPoolEntry,
  type WorkflowTalentPoolEvent,
  type WorkflowTalentPoolStatus,
} from '../services/api';
import { Modal } from './Modal';

const statusLabels: Record<WorkflowTalentPoolStatus, string> = {
  DISPONIVEL: 'Disponível',
  CONTATADO: 'Contatado',
  AGUARDANDO_RESPOSTA: 'Aguardando resposta',
  INDISPONIVEL: 'Não disponível',
  CONVERTIDO_EM_CANDIDATO: 'Convertido em candidato',
};

const editableStatuses: WorkflowTalentPoolStatus[] = [
  'DISPONIVEL',
  'CONTATADO',
  'AGUARDANDO_RESPOSTA',
  'INDISPONIVEL',
];

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();

const candidateName = (entry: WorkflowTalentPoolEntry) =>
  String(entry.record.data.nome ?? entry.record.data.nome_completo ?? entry.record.phone ?? 'Candidato');

const interestValues = (entry: WorkflowTalentPoolEntry) =>
  Object.entries(entry.record.data)
    .filter(([key]) => /area|vaga|funcao|oportunidade/i.test(normalize(key)))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .map(value => String(value ?? '').trim())
    .filter(value => value && normalize(value) !== 'banco de talentos');

const cityValue = (entry: WorkflowTalentPoolEntry) =>
  String(
    entry.record.data.endereco_cidade ?? entry.record.data.cidade ?? entry.record.data.municipio ?? 'Não informada',
  );

const nearestLocation = (entry: WorkflowTalentPoolEntry) =>
  entry.record.proximityData?.results.find(result => result.routeAvailable)?.nome ?? 'Sem localização calculada';

interface TalentBankProps {
  sessionId: string;
  canWrite: boolean;
  refreshRevision: number;
  onCandidateSelect: (record: WorkflowRecord) => void;
}

export function TalentBank({ sessionId, canWrite, refreshRevision, onCandidateSelect }: TalentBankProps) {
  const toast = useToast();
  const [entries, setEntries] = useState<WorkflowTalentPoolEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [area, setArea] = useState('all');
  const [city, setCity] = useState('all');
  const [location, setLocation] = useState('all');
  const [dateOrder, setDateOrder] = useState<'newest' | 'oldest'>('newest');
  const [drafts, setDrafts] = useState<Record<string, { status: WorkflowTalentPoolStatus; owner: string; note: string }>>(
    {},
  );
  const [historyEntry, setHistoryEntry] = useState<WorkflowTalentPoolEntry | null>(null);
  const [events, setEvents] = useState<WorkflowTalentPoolEvent[]>([]);
  const requestRevision = useRef(0);

  const load = async (quiet = false) => {
    if (!sessionId) return;
    const revision = ++requestRevision.current;
    const requestedSessionId = sessionId;
    if (!quiet) setLoading(true);
    try {
      const rows = await workflowHubApi.talentPoolEntries(sessionId);
      if (revision !== requestRevision.current || requestedSessionId !== sessionId) return;
      setEntries(rows);
      setDrafts(current => {
        const next = { ...current };
        for (const entry of rows)
          next[entry.id] ??= { status: entry.status, owner: entry.owner ?? '', note: '' };
        return next;
      });
    } catch (error) {
      if (!quiet) toast.error(error instanceof Error ? error.message : 'Falha ao carregar o Banco de Talentos');
    } finally {
      if (!quiet && revision === requestRevision.current) setLoading(false);
    }
  };
  const loadCurrent = useEffectEvent((quiet = false) => load(quiet));

  useEffect(() => {
    requestRevision.current += 1;
    setEntries([]);
    setDrafts({});
    setSearch('');
    setHistoryEntry(null);
    setEvents([]);
    void loadCurrent();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCurrent(true);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [sessionId, refreshRevision]);

  const areas = useMemo(
    () => [...new Set(entries.flatMap(interestValues))].sort((left, right) => left.localeCompare(right, 'pt-BR')),
    [entries],
  );
  const cities = useMemo(
    () => [...new Set(entries.map(cityValue))].sort((left, right) => left.localeCompare(right, 'pt-BR')),
    [entries],
  );
  const locations = useMemo(
    () => [...new Set(entries.map(nearestLocation))].sort((left, right) => left.localeCompare(right, 'pt-BR')),
    [entries],
  );
  const filtered = useMemo(() => {
    const needle = normalize(search);
    return entries.filter(entry => {
      if (status !== 'all' && entry.status !== status) return false;
      if (area !== 'all' && !interestValues(entry).includes(area)) return false;
      if (city !== 'all' && cityValue(entry) !== city) return false;
      if (location !== 'all' && nearestLocation(entry) !== location) return false;
      if (!needle) return true;
      return normalize(
        `${candidateName(entry)} ${entry.record.phone ?? ''} ${entry.instance.name} ${cityValue(entry)} ${interestValues(entry).join(' ')} ${JSON.stringify(entry.record.data)}`,
      ).includes(needle);
    }).sort((left, right) => {
      const difference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return dateOrder === 'newest' ? difference : -difference;
    });
  }, [area, city, dateOrder, entries, location, search, status]);

  const save = async (entry: WorkflowTalentPoolEntry) => {
    const draft = drafts[entry.id];
    if (!draft || savingId) return;
    setSavingId(entry.id);
    try {
      const saved = await workflowHubApi.updateTalentPoolEntry(sessionId, entry.id, {
        expectedVersion: entry.version,
        status: draft.status,
        owner: draft.owner || null,
        note: draft.note,
      });
      setEntries(current => current.map(item => (item.id === saved.id ? saved : item)));
      setDrafts(current => ({ ...current, [entry.id]: { status: saved.status, owner: saved.owner ?? '', note: '' } }));
      toast.success('Acompanhamento do Banco de Talentos salvo.');
    } catch (error) {
      const status = (error as (Error & { status?: number }) | null)?.status;
      if (status === 409) {
        toast.error('Este cadastro foi alterado por outra pessoa. A lista foi atualizada; revise os dados e tente novamente.');
        await load(true);
      } else {
        toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o acompanhamento');
      }
    } finally {
      setSavingId(null);
    }
  };

  const openHistory = async (entry: WorkflowTalentPoolEntry) => {
    setHistoryEntry(entry);
    setEvents([]);
    try {
      setEvents(await workflowHubApi.talentPoolEvents(sessionId, entry.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível carregar o histórico');
    }
  };

  return (
    <section className="talent-card talent-bank-workspace">
      <div className="candidate-heading">
        <div>
          <h2><UserRoundSearch size={21} /> Banco de Talentos</h2>
          <p>Cadastros para oportunidades futuras. Ao marcar uma entrevista, a pessoa passa automaticamente para Candidatos.</p>
        </div>
        <strong>{filtered.length} de {entries.length}</strong>
      </div>
      <div className="talent-bank-filters">
        <label className="talent-search">
          <Search size={17} />
          <input
            aria-label="Pesquisar no Banco de Talentos"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Pesquisar em todo o cadastro"
          />
        </label>
        <select value={status} onChange={event => setStatus(event.target.value)} aria-label="Filtrar por status">
          <option value="all">Todos os status</option>
          {editableStatuses.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}
        </select>
        <select value={area} onChange={event => setArea(event.target.value)} aria-label="Filtrar por área desejada">
          <option value="all">Todas as áreas desejadas</option>
          {areas.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={city} onChange={event => setCity(event.target.value)} aria-label="Filtrar por cidade">
          <option value="all">Todas as cidades</option>
          {cities.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={location} onChange={event => setLocation(event.target.value)} aria-label="Filtrar pela unidade mais próxima">
          <option value="all">Todas as unidades próximas</option>
          {locations.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={dateOrder} onChange={event => setDateOrder(event.target.value as 'newest' | 'oldest')} aria-label="Ordenar por data de cadastro">
          <option value="newest">Cadastros mais recentes</option>
          <option value="oldest">Cadastros mais antigos</option>
        </select>
      </div>
      {loading ? <p className="agenda-empty">Carregando Banco de Talentos...</p> : (
        <div className="talent-bank-grid">
          {filtered.map(entry => {
            const draft = drafts[entry.id] ?? { status: entry.status, owner: entry.owner ?? '', note: '' };
            return (
              <article className="talent-bank-card" key={entry.id} data-status={entry.status}>
                <button
                  type="button"
                  className="talent-bank-profile"
                  onClick={() => onCandidateSelect({ ...entry.record, instanceName: entry.instance.name })}
                >
                  <span><strong>{candidateName(entry)}</strong><small>{entry.record.phone || 'Contato não identificado'}</small></span>
                  <span><BriefcaseBusiness size={15} /> {interestValues(entry).join(', ') || 'Área futura não informada'}</span>
                  <span>{cityValue(entry)} · {entry.instance.name}</span>
                  <span>Unidade mais próxima: {nearestLocation(entry)}</span>
                  <span>Cadastro: {new Date(entry.createdAt).toLocaleDateString('pt-BR')} · válido até {new Date(entry.record.validUntil).toLocaleDateString('pt-BR')}</span>
                </button>
                <div className="talent-bank-controls">
                  <label><span>Status</span><select disabled={!canWrite} value={draft.status} onChange={event => setDrafts(current => ({ ...current, [entry.id]: { ...draft, status: event.target.value as WorkflowTalentPoolStatus } }))}>{editableStatuses.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
                  <label><span>Responsável</span><input disabled={!canWrite} value={draft.owner} onChange={event => setDrafts(current => ({ ...current, [entry.id]: { ...draft, owner: event.target.value } }))} placeholder="Nome do responsável" /></label>
                  <label className="talent-bank-note"><span>Observação interna</span><input disabled={!canWrite} value={draft.note} onChange={event => setDrafts(current => ({ ...current, [entry.id]: { ...draft, note: event.target.value } }))} placeholder="Registrar contato, retorno ou recusa" /></label>
                </div>
                <footer>
                  <button type="button" className="btn-secondary" onClick={() => void openHistory(entry)}><History size={15} /> Histórico</button>
                  {canWrite && <button type="button" className="btn-primary" disabled={savingId === entry.id} onClick={() => void save(entry)}>{savingId === entry.id ? 'Salvando...' : 'Salvar acompanhamento'}</button>}
                </footer>
              </article>
            );
          })}
          {!filtered.length && <p className="agenda-empty">Nenhum cadastro encontrado com estes filtros.</p>}
        </div>
      )}
      <Modal open={Boolean(historyEntry)} onClose={() => setHistoryEntry(null)} title={historyEntry ? `Histórico de ${candidateName(historyEntry)}` : 'Histórico'} closeLabel="Fechar histórico">
        <div className="recruitment-history talent-bank-history">
          {events.map(event => <div key={event.id}><strong>{event.type === 'TALENT_POOL_REGISTERED' ? 'Entrada no Banco de Talentos' : event.type === 'STATUS_CHANGED' ? `${event.fromStatus ? statusLabels[event.fromStatus] : ''} → ${event.toStatus ? statusLabels[event.toStatus] : ''}` : event.type === 'NOTE_ADDED' ? 'Observação adicionada' : event.type}</strong><span>{new Date(event.createdAt).toLocaleString('pt-BR')}</span>{event.note && <p>{event.note}</p>}</div>)}
          {!events.length && <p>Nenhum evento registrado.</p>}
        </div>
      </Modal>
    </section>
  );
}
