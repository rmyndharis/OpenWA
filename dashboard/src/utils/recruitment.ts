import type { WorkflowInterviewPhase, WorkflowRecruitmentEvent, WorkflowRecruitmentStatus } from '../services/api';

export const recruitmentStatusLabels: Record<WorkflowRecruitmentStatus, string> = {
  ENTREVISTA_MARCADA: 'Entrevista marcada',
  EM_AVALIACAO: 'Em avaliação',
  APROVADO: '2ª fase — Entrevista teste',
  EM_AVALIACAO_FASE_2: 'Em avaliação — 2ª fase',
  DOCUMENTACAO: '3ª fase — Entrevista com DP',
  CONTRATADO: 'Contratado',
  REPROVADO: 'Reprovado',
  NAO_COMPARECEU: 'Não compareceu',
  DESISTIU: 'Desistiu',
  ENTREVISTA_CANCELADA: 'Entrevista cancelada',
};

/**
 * Derives the candidate's current interview phase from the recruitment state.
 * This deliberately does not use the last appointment: a completed second-phase
 * appointment must not remain visible after the candidate advances to DP.
 */
export const recruitmentCurrentInterviewPhase = (status: WorkflowRecruitmentStatus): WorkflowInterviewPhase | null => {
  if (status === 'ENTREVISTA_MARCADA' || status === 'EM_AVALIACAO') return 'FASE_1_ENTREVISTA_SIMPLES';
  if (status === 'APROVADO' || status === 'EM_AVALIACAO_FASE_2') return 'FASE_2_ENTREVISTA_FOCADA';
  if (status === 'DOCUMENTACAO') return 'FASE_3_CONTRATACAO';
  return null;
};

const eventDate = (event: WorkflowRecruitmentEvent, key: string) => {
  const value = event.metadata?.[key];
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('pt-BR');
};

export const recruitmentEventTitle = (event: WorkflowRecruitmentEvent) => {
  if (event.type === 'APPOINTMENT_RESCHEDULED') return 'Entrevista reagendada';
  if (event.type === 'APPOINTMENT_CONFIRMED' || event.type === 'APPOINTMENT_IMPORTED') return 'Entrevista marcada';
  if (event.type === 'APPOINTMENT_CANCELLED') return 'Entrevista cancelada';
  if (event.type === 'INTERVIEW_COMPLETED') return 'Entrevista concluída';
  if (event.toStatus) return recruitmentStatusLabels[event.toStatus];
  return event.type === 'NOTE_ADDED' ? 'Observação adicionada' : 'Acompanhamento atualizado';
};

export const recruitmentEventAppointmentDetail = (event: WorkflowRecruitmentEvent) => {
  const scheduled = eventDate(event, 'appointmentStartsAt');
  if (!scheduled) return null;
  const previous = eventDate(event, 'previousAppointmentStartsAt');
  const location = typeof event.metadata.location === 'string' ? event.metadata.location : '';
  if (previous) return `Horário anterior: ${previous}. Novo horário: ${scheduled}${location ? ` — ${location}` : ''}.`;
  return `Entrevista para ${scheduled}${location ? ` — ${location}` : ''}.`;
};

export const recruitmentRequiredInterviewPhase = (
  from: WorkflowRecruitmentStatus,
  to: WorkflowRecruitmentStatus,
): WorkflowInterviewPhase | null => {
  if (from === 'EM_AVALIACAO' && to === 'APROVADO') return 'FASE_2_ENTREVISTA_FOCADA';
  if (from === 'EM_AVALIACAO_FASE_2' && to === 'APROVADO') return 'FASE_2_ENTREVISTA_FOCADA';
  if (from === 'EM_AVALIACAO_FASE_2' && to === 'DOCUMENTACAO') return 'FASE_3_CONTRATACAO';
  return null;
};

export const recruitmentTransitionLabel = (from: WorkflowRecruitmentStatus, to: WorkflowRecruitmentStatus): string => {
  if (from === 'ENTREVISTA_MARCADA' && to === 'EM_AVALIACAO') return 'Compareceu';
  if (from === 'APROVADO' && to === 'EM_AVALIACAO_FASE_2') return 'Entrevista realizada';
  if (from === 'EM_AVALIACAO_FASE_2' && to === 'APROVADO') return 'Marcar nova entrevista/teste';
  if (from === 'CONTRATADO' && to === 'DESISTIU') return 'Desistir da vaga';
  return recruitmentStatusLabels[to];
};

export type RecruitmentTransitionGroup = 'advance' | 'hold' | 'close';

export const recruitmentTransitionGroup = (
  from: WorkflowRecruitmentStatus,
  to: WorkflowRecruitmentStatus,
): RecruitmentTransitionGroup => {
  if (['REPROVADO', 'NAO_COMPARECEU', 'DESISTIU', 'ENTREVISTA_CANCELADA'].includes(to)) return 'close';
  if (
    (from === 'EM_AVALIACAO' && to === 'APROVADO') ||
    (from === 'EM_AVALIACAO_FASE_2' && to === 'DOCUMENTACAO') ||
    (from === 'DOCUMENTACAO' && to === 'CONTRATADO')
  )
    return 'advance';
  return 'hold';
};
