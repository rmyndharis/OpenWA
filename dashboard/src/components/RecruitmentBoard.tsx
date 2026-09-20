import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import {
  BriefcaseBusiness,
  CalendarClock,
  CalendarPlus,
  Layers3,
  Plus,
  Search,
  Star,
  UserRoundCheck,
} from 'lucide-react';
import { Modal } from './Modal';
import { WorkflowDateTimePicker } from './WorkflowDateTimePicker';
import { useToast } from '../hooks/useToast';
import {
  workflowHubApi,
  type WorkflowDepartment,
  type WorkflowInstance,
  type WorkflowInterviewPhase,
  type WorkflowRecruitmentApplication,
  type WorkflowRecruitmentEvent,
  type WorkflowRecruitmentStatus,
  type WorkflowSlot,
} from '../services/api';
import {
  recruitmentCurrentInterviewPhase,
  recruitmentEventAppointmentDetail,
  recruitmentEventTitle,
  recruitmentRequiredInterviewPhase,
  recruitmentStatusLabels,
  recruitmentTransitionGroup,
  recruitmentTransitionLabel,
} from '../utils/recruitment';

const activeColumns: Array<{ id: string; label: string; statuses: WorkflowRecruitmentStatus[] }> = [
  { id: 'simple-interview', label: '1ª fase — Entrevista simples', statuses: ['ENTREVISTA_MARCADA'] },
  { id: 'simple-evaluation', label: 'Em avaliação — 1ª fase', statuses: ['EM_AVALIACAO'] },
  { id: 'focused-interview', label: '2ª fase — Entrevista teste', statuses: ['APROVADO'] },
  { id: 'focused-evaluation', label: 'Em avaliação — 2ª fase', statuses: ['EM_AVALIACAO_FASE_2'] },
  { id: 'hiring', label: '3ª fase — Entrevista com DP', statuses: ['DOCUMENTACAO'] },
];

type RecruitmentView = 'active' | 'hired' | 'closed';
const activeStatuses = activeColumns.flatMap(column => column.statuses);
const closedStatuses: WorkflowRecruitmentStatus[] = ['REPROVADO', 'NAO_COMPARECEU', 'DESISTIU', 'ENTREVISTA_CANCELADA'];

const nextStatuses: Record<WorkflowRecruitmentStatus, WorkflowRecruitmentStatus[]> = {
  ENTREVISTA_MARCADA: ['EM_AVALIACAO', 'NAO_COMPARECEU'],
  EM_AVALIACAO: ['APROVADO', 'REPROVADO', 'DESISTIU'],
  APROVADO: ['EM_AVALIACAO_FASE_2', 'NAO_COMPARECEU', 'REPROVADO', 'DESISTIU'],
  EM_AVALIACAO_FASE_2: ['DOCUMENTACAO', 'REPROVADO', 'DESISTIU', 'APROVADO'],
  DOCUMENTACAO: ['CONTRATADO', 'REPROVADO', 'DESISTIU', 'APROVADO'],
  CONTRATADO: ['DESISTIU'],
  REPROVADO: ['EM_AVALIACAO'],
  NAO_COMPARECEU: ['EM_AVALIACAO'],
  DESISTIU: ['EM_AVALIACAO'],
  ENTREVISTA_CANCELADA: [],
};

const interviewPhaseName = (phase: WorkflowInterviewPhase) =>
  phase === 'FASE_2_ENTREVISTA_FOCADA' ? '2ª fase — Entrevista teste' : '3ª fase — Entrevista com DP';

const candidateName = (application: WorkflowRecruitmentApplication) =>
  String(
    application.record?.data.nome ?? application.record?.data.nome_completo ?? application.record?.phone ?? 'Candidato',
  );

const displayContact = (application: WorkflowRecruitmentApplication) => {
  const value = application.record?.phone || application.contactId.split('@')[0];
  return value || 'Contato não identificado';
};

const normalizeArea = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();

const normalizeFieldIdentifier = (value: string) => normalizeArea(value).replace(/[^a-z0-9]+/g, '_');

const isInterestAreaIdentifier = (value: string) => {
  const normalized = normalizeFieldIdentifier(value);
  return normalized.includes('area_de_interesse') || normalized.includes('area_interesse');
};

const toLocalInput = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

interface RecruitmentBoardProps {
  sessionId: string;
  flows: WorkflowInstance[];
  canWrite: boolean;
  onApplicationsChange?: (applications: WorkflowRecruitmentApplication[]) => void;
}

export function RecruitmentBoard({
  sessionId,
  flows,
  canWrite,
  onApplicationsChange,
}: RecruitmentBoardProps) {
  const toast = useToast();
  const [applications, setApplications] = useState<WorkflowRecruitmentApplication[]>([]);
  const [selected, setSelected] = useState<WorkflowRecruitmentApplication | null>(null);
  const [events, setEvents] = useState<WorkflowRecruitmentEvent[]>([]);
  const [processView, setProcessView] = useState<RecruitmentView>('active');
  const [areaFilter, setAreaFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [owner, setOwner] = useState('');
  const [rating, setRating] = useState(0);
  const [nextActionAt, setNextActionAt] = useState('');
  const [note, setNote] = useState('');
  const [phaseAdvance, setPhaseAdvance] = useState<{
    application: WorkflowRecruitmentApplication;
    phase: WorkflowInterviewPhase;
  } | null>(null);
  const [phaseSlots, setPhaseSlots] = useState<WorkflowSlot[]>([]);
  const [phaseSlotId, setPhaseSlotId] = useState('');
  const [phaseSlotsLoading, setPhaseSlotsLoading] = useState(false);
  const [phaseDepartment, setPhaseDepartment] = useState<WorkflowDepartment | null>(null);
  const [phaseSlotBuilderOpen, setPhaseSlotBuilderOpen] = useState(false);
  const [phaseSlotDate, setPhaseSlotDate] = useState('');
  const [phaseSlotLocationId, setPhaseSlotLocationId] = useState('');
  const [phaseSlotInstruction, setPhaseSlotInstruction] = useState('');
  const [phaseSlotResponsible, setPhaseSlotResponsible] = useState('');
  const [phaseSlotCapacity, setPhaseSlotCapacity] = useState(1);
  const [phaseSlotSaving, setPhaseSlotSaving] = useState(false);

  const load = async (quiet = false) => {
    if (!sessionId) {
      setApplications([]);
      onApplicationsChange?.([]);
      setSelected(null);
      setEvents([]);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const rows = await workflowHubApi.recruitmentApplications(sessionId);
      setApplications(rows);
      onApplicationsChange?.(rows);
      setSelected(current => (current ? (rows.find(row => row.id === current.id) ?? null) : null));
    } catch (error) {
      if (!quiet) toast.error(error instanceof Error ? error.message : 'Falha ao carregar o processo seletivo');
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  const loadCurrent = useEffectEvent((quiet = false) => load(quiet));

  useEffect(() => {
    if (!sessionId) return undefined;
    void loadCurrent();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCurrent(true);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [sessionId]);

  const selectedId = selected?.id;
  const hydrateSelected = useEffectEvent(() => {
    const application = selected;
    if (!sessionId || !application) {
      setEvents([]);
      return;
    }
    setOwner(application.owner ?? '');
    setRating(application.rating ?? 0);
    setNextActionAt(toLocalInput(application.nextActionAt));
    setNote('');
    void workflowHubApi
      .recruitmentEvents(sessionId, application.id)
      .then(setEvents)
      .catch(() => setEvents([]));
  });

  useEffect(() => {
    hydrateSelected();
  }, [selectedId, sessionId]);

  const interestFieldKeys = useMemo(() => {
    const byFlow = new Map<string, Set<string>>();
    for (const flow of flows) {
      const keys = new Set<string>();
      for (const version of flow.versions) {
        for (const field of version.fields) {
          const answerKey = field.answerKey ?? field.id;
          if (isInterestAreaIdentifier(field.label) || isInterestAreaIdentifier(answerKey)) keys.add(answerKey);
        }
      }
      byFlow.set(flow.id, keys);
    }
    return byFlow;
  }, [flows]);

  const talentPoolAreaValues = useMemo(() => {
    const values = new Set<string>();
    for (const flow of flows)
      for (const version of flow.versions)
        for (const field of version.fields)
          if (field.talentPoolOption) values.add(normalizeArea(field.talentPoolOption));
    return values;
  }, [flows]);

  const applicationAreas = useCallback(
    (application: WorkflowRecruitmentApplication) => {
      const data = application.record?.data ?? {};
      const configuredKeys = interestFieldKeys.get(application.instanceId) ?? new Set<string>();
      const fallbackKeys = Object.keys(data).filter(isInterestAreaIdentifier);
      const values = [...new Set([...configuredKeys, ...fallbackKeys])].flatMap(key => {
        const value = data[key];
        return Array.isArray(value) ? value : [value];
      });
      return [
        ...new Set(
          values
            .map(value => String(value ?? '').trim())
            .filter(
              value =>
                value && value !== '__OPENWA_SKIPPED__' && !talentPoolAreaValues.has(normalizeArea(value)),
            ),
        ),
      ];
    },
    [interestFieldKeys, talentPoolAreaValues],
  );

  const viewApplications = useMemo(
    () =>
      applications.filter(application => {
        if (processView === 'hired') return application.status === 'CONTRATADO';
        if (processView === 'closed') return closedStatuses.includes(application.status);
        return activeStatuses.includes(application.status);
      }),
    [applications, processView],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('pt-BR');
    return viewApplications.filter(application => {
      if (areaFilter !== 'all' && !applicationAreas(application).some(area => normalizeArea(area) === areaFilter))
        return false;
      if (!needle) return true;
      return `${candidateName(application)} ${displayContact(application)} ${application.instance.name} ${applicationAreas(application).join(' ')}`
        .toLocaleLowerCase('pt-BR')
        .includes(needle);
    });
  }, [viewApplications, areaFilter, search, applicationAreas]);

  const areaOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const flow of flows) {
      for (const version of flow.versions) {
        for (const field of version.fields) {
          const answerKey = field.answerKey ?? field.id;
          if (!interestFieldKeys.get(flow.id)?.has(answerKey)) continue;
          for (const option of field.options ?? []) {
            const label = option.trim();
            if (label && !talentPoolAreaValues.has(normalizeArea(label))) labels.set(normalizeArea(label), label);
          }
        }
      }
    }
    for (const application of applications) {
      for (const area of applicationAreas(application)) labels.set(normalizeArea(area), area);
    }
    return [
      {
        id: 'all',
        name: 'Todas as áreas',
        description: 'Visão geral do processo seletivo',
        count: viewApplications.length,
      },
      ...[...labels.entries()]
        .sort((left, right) => left[1].localeCompare(right[1], 'pt-BR'))
        .map(([id, name]) => ({
          id,
          name,
          description: 'Área de interesse informada no cadastro',
          count: viewApplications.filter(application =>
            applicationAreas(application).some(area => normalizeArea(area) === id),
          ).length,
        })),
    ];
  }, [applications, flows, interestFieldKeys, applicationAreas, talentPoolAreaValues, viewApplications]);

  const processViews: Array<{ id: RecruitmentView; label: string; count: number }> = [
    {
      id: 'active',
      label: 'Em andamento',
      count: applications.filter(application => activeStatuses.includes(application.status)).length,
    },
    {
      id: 'hired',
      label: 'Contratados',
      count: applications.filter(application => application.status === 'CONTRATADO').length,
    },
    {
      id: 'closed',
      label: 'Encerrados',
      count: applications.filter(application => closedStatuses.includes(application.status)).length,
    },
  ];

  useEffect(() => {
    if (areaFilter !== 'all' && !areaOptions.some(area => area.id === areaFilter)) setAreaFilter('all');
  }, [areaFilter, areaOptions]);

  const update = async (
    application: WorkflowRecruitmentApplication,
    patch: Parameters<typeof workflowHubApi.updateRecruitmentApplication>[2],
  ) => {
    setSaving(true);
    try {
      const saved = await workflowHubApi.updateRecruitmentApplication(sessionId, application.id, patch);
      const [rows, updatedEvents] = await Promise.all([
        workflowHubApi.recruitmentApplications(sessionId),
        workflowHubApi.recruitmentEvents(sessionId, application.id),
      ]);
      setApplications(rows);
      onApplicationsChange?.(rows);
      setSelected(current => (current?.id === saved.id ? (rows.find(item => item.id === saved.id) ?? saved) : current));
      setEvents(updatedEvents);
      toast.success(
        patch.status ? `Candidato movido para ${recruitmentStatusLabels[patch.status]}` : 'Acompanhamento salvo',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível atualizar a candidatura');
    } finally {
      setSaving(false);
    }
  };

  const openPhaseAdvance = async (application: WorkflowRecruitmentApplication, phase: WorkflowInterviewPhase) => {
    setPhaseAdvance({ application, phase });
    setPhaseSlotId('');
    setPhaseSlots([]);
    setPhaseDepartment(null);
    setPhaseSlotBuilderOpen(false);
    setPhaseSlotDate('');
    setPhaseSlotLocationId('');
    setPhaseSlotInstruction('');
    setPhaseSlotResponsible('');
    setPhaseSlotCapacity(1);
    setSelected(null);
    setPhaseSlotsLoading(true);
    try {
      const [rows, department] = await Promise.all([
        workflowHubApi.slots(sessionId, application.instanceId),
        workflowHubApi.department(sessionId),
      ]);
      setPhaseDepartment(department);
      setPhaseSlots(
        rows.filter(
          slot =>
            slot.interviewPhase === phase &&
            slot.status === 'DISPONIVEL' &&
            slot.bookedCount < slot.capacity &&
            Date.parse(slot.startsAt) > Date.now(),
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível carregar os horários da próxima fase');
    } finally {
      setPhaseSlotsLoading(false);
    }
  };

  const closePhaseAdvance = () => {
    setSelected(phaseAdvance?.application ?? null);
    setPhaseAdvance(null);
    setPhaseSlotId('');
    setPhaseSlotBuilderOpen(false);
    setPhaseSlotDate('');
    setPhaseSlotLocationId('');
  };

  const createPhaseSlot = async () => {
    if (!phaseAdvance || !phaseSlotDate || !phaseSlotLocationId || phaseSlotSaving) return;
    const startsAt = new Date(phaseSlotDate);
    if (Number.isNaN(startsAt.getTime()) || startsAt <= new Date()) {
      toast.error('Escolha uma data e um horário futuros.');
      return;
    }
    const location = phaseDepartment?.schedule.locations?.find(item => item.id === phaseSlotLocationId);
    if (!location) {
      toast.error('Selecione um local cadastrado.');
      return;
    }
    setPhaseSlotSaving(true);
    try {
      const [created] = await workflowHubApi.createSlots(sessionId, phaseAdvance.application.instanceId, [
        {
          startsAt: startsAt.toISOString(),
          capacity: phaseSlotCapacity,
          locationId: location.id,
          location: location.name,
          address: location.address,
          mapsUrl: location.mapsUrl,
          instruction: phaseSlotInstruction.trim() || undefined,
          responsible: phaseSlotResponsible.trim() || undefined,
          interviewPhase: phaseAdvance.phase,
        },
      ]);
      if (!created) throw new Error('O servidor não retornou o horário criado.');
      setPhaseSlots(current =>
        [...current.filter(slot => slot.id !== created.id), created].sort(
          (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
        ),
      );
      setPhaseSlotId(created.id);
      setPhaseSlotBuilderOpen(false);
      setPhaseSlotDate('');
      toast.success('Horário criado e selecionado. Agora confirme a entrevista.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível criar o horário.');
    } finally {
      setPhaseSlotSaving(false);
    }
  };

  const confirmPhaseAdvance = async () => {
    if (!phaseAdvance || !phaseSlotId || saving) return;
    if (!phaseAdvance.application.recordId) {
      toast.error('O candidato não possui cadastro vinculado para marcar a próxima entrevista.');
      return;
    }
    setSaving(true);
    try {
      await workflowHubApi.scheduleRecordAppointment(
        sessionId,
        phaseAdvance.application.instanceId,
        phaseAdvance.application.recordId,
        phaseSlotId,
      );
      const scheduledStatus: WorkflowRecruitmentStatus =
        phaseAdvance.phase === 'FASE_2_ENTREVISTA_FOCADA' ? 'APROVADO' : 'DOCUMENTACAO';
      await workflowHubApi.updateRecruitmentApplication(sessionId, phaseAdvance.application.id, {
        status: scheduledStatus,
      });
      const rows = await workflowHubApi.recruitmentApplications(sessionId);
      setApplications(rows);
      onApplicationsChange?.(rows);
      toast.success(`Nova data marcada para ${interviewPhaseName(phaseAdvance.phase)}.`);
      setPhaseAdvance(null);
      setPhaseSlotId('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível marcar a entrevista da próxima fase');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="talent-card recruitment-workspace">
      <div className="recruitment-heading">
        <div>
          <h2>
            <UserRoundCheck size={21} /> Processo seletivo
          </h2>
          <p>A triagem permanece no fluxo. Aqui o acompanhamento começa quando a entrevista é marcada.</p>
        </div>
        <strong>{applications.length} candidaturas</strong>
      </div>
      <div className="recruitment-view-tabs" role="tablist" aria-label="Visualização do processo seletivo">
        {processViews.map(view => (
          <button
            type="button"
            role="tab"
            key={view.id}
            aria-selected={processView === view.id}
            className={processView === view.id ? 'active' : ''}
            onClick={() => setProcessView(view.id)}
          >
            <span>{view.label}</span>
            <strong>{view.count}</strong>
          </button>
        ))}
      </div>
      <div className="recruitment-vacancy-section">
        <div className="recruitment-vacancy-heading">
          <div>
            <span>Áreas de interesse</span>
            <strong>Escolha uma área para visualizar</strong>
          </div>
          {areaFilter !== 'all' && (
            <button type="button" className="btn-secondary" onClick={() => setAreaFilter('all')}>
              Mostrar todas
            </button>
          )}
        </div>
        <div
          className="recruitment-vacancies"
          role="group"
          aria-label="Filtrar processo seletivo por área de interesse"
        >
          {areaOptions.map((area, index) => (
            <button
              type="button"
              key={area.id}
              className={`recruitment-vacancy-card ${areaFilter === area.id ? 'active' : ''}`}
              aria-pressed={areaFilter === area.id}
              onClick={() => setAreaFilter(area.id)}
            >
              <span className="recruitment-vacancy-icon">
                {index === 0 ? <Layers3 size={19} /> : <BriefcaseBusiness size={19} />}
              </span>
              <span className="recruitment-vacancy-copy">
                <strong>{area.name}</strong>
                <small>{area.description}</small>
              </span>
              <span className="recruitment-vacancy-count">{area.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="recruitment-filters">
        <div className="talent-search">
          <Search size={17} />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Pesquisar candidato" />
        </div>
      </div>
      {loading ? (
        <p className="agenda-empty">Carregando processo seletivo...</p>
      ) : processView === 'active' ? (
        <div className="recruitment-board">
          {activeColumns.map(column => {
            const cards = filtered.filter(application => column.statuses.includes(application.status));
            return (
              <div className="recruitment-column" key={column.id} data-status={column.statuses[0]}>
                <header>
                  <span>{column.label}</span>
                  <strong>{cards.length}</strong>
                </header>
                <div className="recruitment-column-body">
                  {cards.map(application => {
                    const currentPhase = recruitmentCurrentInterviewPhase(application.status);
                    return (
                      <button
                        className="recruitment-card"
                        key={application.id}
                        data-status={application.status}
                        onClick={() => setSelected(application)}
                      >
                        <strong>{candidateName(application)}</strong>
                        <span>{application.instance.name}</span>
                        {currentPhase && (
                          <small className="recruitment-card-phase">{interviewPhaseName(currentPhase)}</small>
                        )}
                        {applicationAreas(application).length > 0 && (
                          <small>Área: {applicationAreas(application).join(', ')}</small>
                        )}
                        {application.appointment?.slot && (
                          <small>
                            <CalendarClock size={13} />{' '}
                            {new Date(application.appointment.slot.startsAt).toLocaleString('pt-BR')}
                          </small>
                        )}
                        {application.owner && <small>Responsável: {application.owner}</small>}
                        {application.rating && (
                          <small>
                            <Star size={13} /> {application.rating}/5
                          </small>
                        )}
                      </button>
                    );
                  })}
                  {!cards.length && <p>Nenhum candidato</p>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="recruitment-compact-list">
          {filtered.map(application => (
            <button
              type="button"
              className="recruitment-compact-card"
              key={application.id}
              onClick={() => setSelected(application)}
            >
              <span className="recruitment-compact-main">
                <strong>{candidateName(application)}</strong>
                <small>{displayContact(application)}</small>
              </span>
              <span>
                <small>Área de interesse</small>
                <strong>{applicationAreas(application).join(', ') || 'Não informada'}</strong>
              </span>
              <span>
                <small>Responsável</small>
                <strong>{application.owner || 'Não definido'}</strong>
              </span>
              <span>
                <small>Status</small>
                <strong className="candidate-status" data-status={application.status}>
                  {recruitmentStatusLabels[application.status]}
                </strong>
              </span>
              <span>
                <small>Atualizado em</small>
                <strong>{new Date(application.updatedAt).toLocaleString('pt-BR')}</strong>
              </span>
            </button>
          ))}
          {!filtered.length && (
            <p className="candidate-process-empty">
              {processView === 'hired' ? 'Nenhum contratado encontrado.' : 'Nenhum processo encerrado encontrado.'}
            </p>
          )}
        </div>
      )}
      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Processo de ${candidateName(selected)}` : 'Candidatura'}
        closeLabel="Fechar acompanhamento"
        className="recruitment-modal"
        footer={
          selected ? (
            <div className="recruitment-modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setSelected(null)}>
                Fechar
              </button>
              {canWrite && (
                <button
                  className="btn-primary"
                  disabled={saving}
                  onClick={() =>
                    void update(selected, {
                      owner: owner || null,
                      rating: rating || null,
                      nextActionAt: nextActionAt ? new Date(nextActionAt).toISOString() : null,
                      note,
                    })
                  }
                >
                  {saving ? 'Salvando...' : 'Salvar acompanhamento'}
                </button>
              )}
            </div>
          ) : undefined
        }
      >
        {selected && (
          <div className="recruitment-details">
            <div className="recruitment-summary-grid">
              <div>
                <span>Etapa</span>
                <strong>
                  <span className="candidate-status" data-status={selected.status}>
                    {recruitmentStatusLabels[selected.status]}
                  </span>
                </strong>
              </div>
              <div>
                <span>Fluxo</span>
                <strong>{selected.instance.name}</strong>
              </div>
              <div>
                <span>Contato</span>
                <strong>{displayContact(selected)}</strong>
              </div>
              <div>
                <span>Entrevista</span>
                <strong>
                  {selected.appointment?.slot
                    ? new Date(selected.appointment.slot.startsAt).toLocaleString('pt-BR')
                    : 'Sem horário ativo'}
                </strong>
              </div>
            </div>
            {canWrite && (
              <div className="recruitment-actions">
                <h3>Alterar etapa</h3>
                <div className="recruitment-transition-groups">
                  {(
                    [
                      ['advance', 'Passar para a próxima fase'],
                      ['hold', 'Manter ou retornar na fase'],
                      ['close', 'Encerrar participação'],
                    ] as const
                  ).map(([group, label]) => {
                    const statuses = nextStatuses[selected.status].filter(
                      status => recruitmentTransitionGroup(selected.status, status) === group,
                    );
                    return (
                      <div className="recruitment-transition-row" data-group={group} key={group}>
                        <span>{label}</span>
                        <div>
                          {statuses.map(status => (
                            <button
                              key={status}
                              className="btn-secondary recruitment-transition"
                              data-status={status}
                              disabled={saving}
                              onClick={() => {
                                const phase = recruitmentRequiredInterviewPhase(selected.status, status);
                                if (phase) void openPhaseAdvance(selected, phase);
                                else void update(selected, { status });
                              }}
                            >
                              {recruitmentTransitionLabel(selected.status, status)}
                            </button>
                          ))}
                          {!statuses.length && <small>Nenhuma ação disponível</small>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="recruitment-form">
              <h3>Acompanhamento</h3>
              <label>
                Responsável
                <input
                  value={owner}
                  disabled={!canWrite}
                  maxLength={120}
                  onChange={event => setOwner(event.target.value)}
                />
              </label>
              <label>
                Avaliação
                <select value={rating} disabled={!canWrite} onChange={event => setRating(Number(event.target.value))}>
                  <option value={0}>Sem avaliação</option>
                  {[1, 2, 3, 4, 5].map(value => (
                    <option key={value} value={value}>
                      {value} de 5
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Próxima ação
                <input
                  type="datetime-local"
                  value={nextActionAt}
                  disabled={!canWrite}
                  onChange={event => setNextActionAt(event.target.value)}
                />
              </label>
              <label className="recruitment-note">
                Observação
                <textarea
                  value={note}
                  disabled={!canWrite}
                  maxLength={2000}
                  onChange={event => setNote(event.target.value)}
                  placeholder="Registre apenas informações necessárias ao processo."
                />
              </label>
            </div>
            <div className="recruitment-history">
              <h3>Histórico</h3>
              {events.map(event => (
                <div key={event.id}>
                  <strong>{recruitmentEventTitle(event)}</strong>
                  <span>Registrado em {new Date(event.createdAt).toLocaleString('pt-BR')}</span>
                  {recruitmentEventAppointmentDetail(event) && <p>{recruitmentEventAppointmentDetail(event)}</p>}
                  {event.note && <p>{event.note}</p>}
                </div>
              ))}
              {!events.length && <p>Nenhum evento registrado.</p>}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(phaseAdvance)}
        onClose={closePhaseAdvance}
        title={phaseAdvance ? `Marcar ${interviewPhaseName(phaseAdvance.phase)}` : 'Marcar próxima entrevista'}
        closeLabel="Cancelar marcação da próxima fase"
        className="confirm-modal reschedule-modal"
        footer={
          phaseAdvance ? (
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={saving || phaseSlotSaving}
                onClick={closePhaseAdvance}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!phaseSlotId || phaseSlotsLoading || phaseSlotSaving || saving}
                onClick={() => void confirmPhaseAdvance()}
              >
                {saving ? 'Salvando...' : 'Confirmar nova entrevista'}
              </button>
            </>
          ) : undefined
        }
      >
        {phaseAdvance && (
          <div className="reschedule-form">
            <p>
              Para avançar <strong>{candidateName(phaseAdvance.application)}</strong>, escolha uma nova data cadastrada
              especificamente para <strong>{interviewPhaseName(phaseAdvance.phase)}</strong>.
            </p>
            <label>
              Nova data da entrevista
              <select
                value={phaseSlotId}
                disabled={phaseSlotsLoading || saving}
                onChange={event => setPhaseSlotId(event.target.value)}
              >
                <option value="">{phaseSlotsLoading ? 'Carregando horários...' : 'Selecione um horário'}</option>
                {phaseSlots.map(slot => (
                  <option key={slot.id} value={slot.id}>
                    {new Date(slot.startsAt).toLocaleString('pt-BR')}
                    {slot.location ? ` — ${slot.location}` : ''} ({slot.capacity - slot.bookedCount} vaga(s))
                  </option>
                ))}
              </select>
            </label>
            {!phaseSlotsLoading && !phaseSlots.length && !phaseSlotBuilderOpen && (
              <p className="outbox-warning">Não há horários futuros disponíveis para esta fase.</p>
            )}
            {!phaseSlotBuilderOpen ? (
              <button
                type="button"
                className="btn-secondary recruitment-create-slot-trigger"
                disabled={phaseSlotsLoading || saving}
                onClick={() => setPhaseSlotBuilderOpen(true)}
              >
                <CalendarPlus size={17} /> Criar novo horário sem sair do processo
              </button>
            ) : (
              <section className="recruitment-inline-slot-builder" aria-labelledby="recruitment-new-slot-title">
                <div className="recruitment-inline-slot-heading">
                  <div>
                    <h3 id="recruitment-new-slot-title">Novo horário</h3>
                    <p>A fase já será definida como {interviewPhaseName(phaseAdvance.phase)}.</p>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary compact"
                    disabled={phaseSlotSaving}
                    onClick={() => setPhaseSlotBuilderOpen(false)}
                  >
                    Recolher
                  </button>
                </div>
                <div className="recruitment-inline-slot-grid">
                  <label>
                    Data e horário
                    <WorkflowDateTimePicker
                      id="recruitment-phase-slot-date"
                      ariaLabel="Data e horário do novo horário da entrevista"
                      value={phaseSlotDate}
                      onChange={setPhaseSlotDate}
                    />
                  </label>
                  <label>
                    Local
                    <select
                      value={phaseSlotLocationId}
                      disabled={phaseSlotSaving}
                      onChange={event => setPhaseSlotLocationId(event.target.value)}
                    >
                      <option value="">Selecione um local cadastrado</option>
                      {(phaseDepartment?.schedule.locations ?? []).map(location => (
                        <option key={location.id} value={location.id}>
                          {location.internalName || location.name}
                          {location.internalName ? ` — ${location.name}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Instrução
                    <input
                      maxLength={1000}
                      value={phaseSlotInstruction}
                      disabled={phaseSlotSaving}
                      onChange={event => setPhaseSlotInstruction(event.target.value)}
                      placeholder="Ex.: Apresente-se na recepção"
                    />
                  </label>
                  <label>
                    Apresentar-se para
                    <input
                      maxLength={160}
                      value={phaseSlotResponsible}
                      disabled={phaseSlotSaving}
                      onChange={event => setPhaseSlotResponsible(event.target.value)}
                      placeholder="Ex.: Amanda"
                    />
                  </label>
                  <label>
                    Limite de pessoas
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      value={phaseSlotCapacity}
                      disabled={phaseSlotSaving}
                      onChange={event => setPhaseSlotCapacity(Math.max(1, Number(event.target.value) || 1))}
                    />
                  </label>
                </div>
                {!(phaseDepartment?.schedule.locations ?? []).length && (
                  <p className="outbox-warning">Cadastre pelo menos um local na Agenda antes de criar o horário.</p>
                )}
                <button
                  type="button"
                  className="btn-primary recruitment-inline-slot-save"
                  disabled={
                    !phaseSlotDate ||
                    !phaseSlotLocationId ||
                    phaseSlotSaving ||
                    !(phaseDepartment?.schedule.locations ?? []).length
                  }
                  onClick={() => void createPhaseSlot()}
                >
                  <Plus size={17} /> {phaseSlotSaving ? 'Criando horário...' : 'Criar e selecionar horário'}
                </button>
              </section>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}
