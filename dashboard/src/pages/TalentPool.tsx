import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  GripVertical,
  MessageSquareText,
  Plus,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Star,
  TimerReset,
  Trash2,
  Undo2,
  Redo2,
  Users,
} from 'lucide-react';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { WorkflowDiagram } from '../components/WorkflowDiagram';
import { WorkflowDateTimePicker } from '../components/WorkflowDateTimePicker';
import { WorkflowSimulator } from '../components/WorkflowSimulator';
import { RecruitmentBoard } from '../components/RecruitmentBoard';
import { TalentBank } from '../components/TalentBank';
import { ProximityTestPanel } from '../components/ProximityTestPanel';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  contactApi,
  pluginsApi,
  sessionApi,
  workflowHubApi,
  type WorkflowAppointment,
  type WorkflowHubRuntimeStatus,
  type WorkflowIndicators,
  type WorkflowInterviewPhase,
  type WorkflowDeletionRequest,
  type WorkflowDepartment,
  type WorkflowField,
  type WorkflowGraphDefinition,
  type WorkflowInstance,
  type WorkflowOutboxHealth,
  type WorkflowRecord,
  type WorkflowRecruitmentApplication,
  type WorkflowRecruitmentEvent,
  type WorkflowRecordMenuAction,
  type WorkflowRecordMenuConfig,
  type WorkflowSlot,
  type WorkflowTicket,
  type WorkflowTicketEvent,
  type WorkflowVersionDefinition,
} from '../services/api';
import './TalentPool.css';
import {
  createLinearWorkflowGraph,
  inspectWorkflowGraph,
  orderWorkflowFieldsByGraph,
  orderWorkflowGraphNodes,
  moveLinearWorkflowNodeTo,
  reconcileWorkflowGraph,
  removeWorkflowMessageNode,
} from '../utils/workflowGraph';
import {
  shouldPollWorkflowTab,
  WORKFLOW_AGENDA_REFRESH_MS,
  WORKFLOW_HUMAN_TICKETS_REFRESH_MS,
  WorkflowRequestGate,
} from '../utils/workflowRefresh';
import { filterAndSortAgendaSlots, nextAgendaLocationEditorId, type AgendaSlotSort } from '../utils/workflowAgenda';
import {
  reconcileCandidateColumnPreferences,
  reorderCandidateColumnPreferences,
  type CandidateColumnPreference,
} from '../utils/candidateColumns';
import { formatDurationMinutes } from '../utils/formatDuration';
import { hasPointerDragStarted, workflowDragPreviewPosition } from '../utils/workflowDrag';
import { isSessionStarted } from '../utils/sessionActions';
import { compareTableValues, toggleTableSort, type TableSortState } from '../utils/tableSort';
import {
  detectHumanTicketChanges,
  snapshotHumanTickets,
  type HumanTicketChange,
  type HumanTicketSnapshot,
} from '../utils/humanTicketNotifications';
import {
  canManageHumanService,
  defaultRecruitmentCenterTab,
  isRecruitmentCenterTabAllowed,
  type RecruitmentCenterTabId,
} from '../utils/roleNavigation';
import {
  recruitmentCurrentInterviewPhase,
  recruitmentEventAppointmentDetail,
  recruitmentEventTitle,
  recruitmentStatusLabels,
} from '../utils/recruitment';

type Tab = RecruitmentCenterTabId;
const recruitmentCenterTabs: readonly Tab[] = [
  'flows',
  'diagram',
  'agenda',
  'recruitment',
  'candidates',
  'talent-bank',
  'tickets',
  'notifications',
  'privacy',
  'settings',
];
const recruitmentCenterTabFromQuery = (value: string | null): Tab | null =>
  recruitmentCenterTabs.includes(value as Tab) ? (value as Tab) : null;
type SettingsCardId = 'department' | 'candidate-columns' | 'proximity-test' | 'timeouts' | 'pdf' | 'reminder';
type CandidateColumn = { id: string; label: string; kind: 'fixed' | 'answer'; answerKey?: string };
type WorkflowEditorSnapshot = { fields: WorkflowField[]; graph: WorkflowGraphDefinition };
type AgendaLocation = NonNullable<WorkflowDepartment['schedule']['locations']>[number];
type LocationContactDraft = {
  id: string;
  role: string;
  name: string;
  ddi: string;
  ddd: string;
  number: string;
  enabled: boolean;
};
type AppointmentNotification = WorkflowInstance['appointmentNotifications'][number];
type AppointmentNotificationEvent = AppointmentNotification['events'][number];
const interviewPhases: Array<{ value: WorkflowInterviewPhase; label: string }> = [
  { value: 'FASE_1_ENTREVISTA_SIMPLES', label: '1ª fase — Entrevista simples' },
  { value: 'FASE_2_ENTREVISTA_FOCADA', label: '2ª fase — Entrevista teste' },
  { value: 'FASE_3_CONTRATACAO', label: '3ª fase — Entrevista com DP' },
];
const interviewPhaseLabel = (phase?: WorkflowInterviewPhase) =>
  interviewPhases.find(item => item.value === phase)?.label ?? interviewPhases[0].label;
const newLocationContact = (): LocationContactDraft => ({
  id: `contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  role: '',
  name: '',
  ddi: '55',
  ddd: '',
  number: '',
  enabled: true,
});
const formatCpf = (value: unknown) => {
  const digits = String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, 11);
  return digits.length === 11 ? digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : digits;
};
const fieldTypes: Array<{ value: WorkflowField['type']; label: string }> = [
  { value: 'text', label: 'Resposta curta' },
  { value: 'textarea', label: 'Resposta longa' },
  { value: 'email', label: 'E-mail' },
  { value: 'phone', label: 'Telefone' },
  { value: 'number', label: 'Número' },
  { value: 'currency', label: 'Valor monetário' },
  { value: 'date', label: 'Data' },
  { value: 'cpf', label: 'CPF' },
  { value: 'cnpj', label: 'CNPJ' },
  { value: 'select', label: 'Escolha única' },
  { value: 'multiselect', label: 'Múltiplas escolhas' },
  { value: 'consent', label: 'Sim ou não / consentimento' },
  { value: 'pdf', label: 'Arquivo PDF' },
  { value: 'appointment', label: 'Horário da agenda' },
];
const fieldTypeGroups: Array<{ label: string; values: WorkflowField['type'][] }> = [
  { label: 'Textos', values: ['text', 'textarea'] },
  { label: 'Dados de contato e documentos', values: ['email', 'phone', 'cpf', 'cnpj'] },
  { label: 'Números e datas', values: ['number', 'currency', 'date'] },
  { label: 'Escolhas', values: ['select', 'multiselect', 'consent'] },
  { label: 'Arquivo e agenda', values: ['pdf', 'appointment'] },
];

const addressResponseTypes: Array<Omit<WorkflowField, 'id' | 'order' | 'answerKey'> & { answerKey: string }> = [
  {
    answerKey: 'endereco_cep',
    label: 'CEP',
    prompt: '📮 Qual é o CEP da sua residência?',
    type: 'cep',
    required: true,
  },
  {
    answerKey: 'endereco_logradouro',
    label: 'Logradouro',
    prompt: '🏠 Qual é o nome da sua rua, avenida ou outro logradouro?',
    type: 'text',
    required: true,
  },
  {
    answerKey: 'endereco_numero',
    label: 'Número do endereço',
    prompt: '🔢 Qual é o número do endereço? Se não tiver, responda S/N.',
    type: 'text',
    required: true,
    validationScript:
      "const text = String(value ?? '').trim(); return /^(?:s\\/?n|[0-9]+[A-Za-z0-9./ -]*)$/i.test(text) ? { valid: true, value: text } : { valid: false, error: 'Informe o número do endereço ou S/N.' };",
  },
  {
    answerKey: 'endereco_complemento',
    label: 'Complemento',
    prompt: '🏢 Informe o complemento. Se não tiver, digite PULAR.',
    type: 'text',
    required: false,
  },
  {
    answerKey: 'endereco_bairro',
    label: 'Bairro',
    prompt: '📍 Em qual bairro você mora?',
    type: 'text',
    required: true,
  },
  {
    answerKey: 'endereco_cidade',
    label: 'Cidade',
    prompt: '🏙️ Em qual cidade você mora?',
    type: 'text',
    required: true,
  },
  {
    answerKey: 'endereco_estado',
    label: 'Estado (UF)',
    prompt: '🗺️ Em qual estado você mora?',
    type: 'text',
    required: true,
    validationScript:
      "const uf = String(value ?? '').trim().toUpperCase(); return /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(uf) ? { valid: true, value: uf } : { valid: false, error: 'Digite uma UF válida com duas letras. Ex.: MG.' };",
  },
];
const addressResponseTypeValue = (answerKey: string) => `address:${answerKey}`;
const responseTypeValue = (field: WorkflowField) => {
  const addressType = addressResponseTypes.find(
    preset => preset.answerKey === field.answerKey && preset.type === field.type,
  );
  if (addressType) return addressResponseTypeValue(addressType.answerKey);
  if (field.type === 'cep') return addressResponseTypeValue('endereco_cep');
  return field.type;
};
const responseTypeLabel = (field: WorkflowField) =>
  addressResponseTypes.find(preset => preset.answerKey === field.answerKey && preset.type === field.type)?.label ??
  (field.type === 'cep' ? 'CEP' : undefined) ??
  fieldTypes.find(type => type.value === field.type)?.label;
const normalizeAnswerKey = (value: string) => {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (!normalized) return 'campo';
  const withLetter = /^[a-z]/.test(normalized) ? normalized : `campo_${normalized}`.slice(0, 64);
  return withLetter.length >= 2 ? withLetter : `campo_${withLetter}`;
};
const uniqueAnswerKey = (value: string, fields: WorkflowField[], currentId?: string) => {
  const base = normalizeAnswerKey(value);
  const used = new Set(fields.filter(field => field.id !== currentId).map(field => field.answerKey ?? field.id));
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 64 - String(suffix).length - 1))}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
};

const recordMenuActionDefaults: Array<{
  action: WorkflowRecordMenuAction;
  label: string;
  description: string;
}> = [
  {
    action: 'CONSULTAR_DADOS',
    label: 'Consultar meus dados',
    description: 'Mostra ao usuário as respostas públicas já salvas.',
  },
  {
    action: 'ATUALIZAR_DADOS',
    label: 'Atualizar meus dados',
    description: 'Permite escolher e validar um campo antes de salvar a alteração.',
  },
  {
    action: 'VISUALIZAR_AGENDAMENTO',
    label: 'Visualizar minha entrevista',
    description: 'Aparece somente quando o usuário possui uma entrevista futura confirmada.',
  },
  {
    action: 'REMARCAR_AGENDAMENTO',
    label: 'Remarcar minha entrevista',
    description: 'Permite ao usuário escolher outro horário disponível para a entrevista atual.',
  },
  {
    action: 'CANCELAR_AGENDAMENTO',
    label: 'Cancelar minha entrevista',
    description: 'Solicita confirmação e cancela a entrevista futura do usuário.',
  },
  {
    action: 'ATENDIMENTO_HUMANO',
    label: 'Falar com atendimento humano',
    description: 'Abre um chamado e deixa o bot em silêncio.',
  },
  {
    action: 'ENCERRAR_ATENDIMENTO',
    label: 'Encerrar atendimento',
    description: 'Fecha a conversa atual; uma nova mensagem abre o menu novamente.',
  },
  {
    action: 'SOLICITAR_EXCLUSAO',
    label: 'Solicitar exclusão dos dados',
    description: 'Bloqueia o cadastro até a decisão do administrador.',
  },
];

const appointmentNotificationEventOptions: Array<{
  value: AppointmentNotificationEvent;
  label: string;
}> = [
  { value: 'CONFIRMADA', label: 'Entrevista marcada' },
  { value: 'CANCELADA', label: 'Entrevista cancelada' },
  { value: 'REAGENDADA', label: 'Entrevista reagendada' },
  { value: 'CONCLUIDA', label: 'Entrevista concluída' },
];

const legacyNotificationRecipients = (values: string[] = []): AppointmentNotification[] =>
  values.map((value, index) => {
    const digits = value.replace(/\D/g, '');
    const hasBrazilDdi = digits.startsWith('55') && digits.length >= 12;
    const local = hasBrazilDdi ? digits.slice(2) : digits;
    return {
      id: `legacy-${digits}`,
      name: `Gestor ${index + 1}`,
      ddi: hasBrazilDdi ? '55' : '',
      ddd: local.slice(0, 2),
      number: local.slice(2),
      events: ['CONFIRMADA', 'CANCELADA'],
      locationIds: [],
      interviewPhases: [],
      enabled: true,
    };
  });

const flowMessageTemplates = [
  {
    key: 'consent',
    label: 'Consentimento inicial',
    help: 'Enviada antes de começar ou renovar o cadastro.',
    placeholder:
      '{contexto}Para iniciar “{fluxo}”, precisamos tratar suas respostas conforme a finalidade deste cadastro. Você concorda? Responda SIM ou NÃO.',
    variables: '{contexto}, {fluxo}',
  },
  {
    key: 'updateConsent',
    label: 'Consentimento para atualização',
    help: 'Enviada antes de permitir alteração dos dados salvos.',
    placeholder:
      'Antes de atualizar seus dados em “{fluxo}”, precisamos registrar um novo consentimento. Você concorda? Responda SIM ou NÃO.',
    variables: '{fluxo}',
  },
  {
    key: 'review',
    label: 'Revisão das respostas',
    help: 'Tela de conferência antes da gravação definitiva. Mantenha {resumo} e as opções 1, 2 e 3.',
    placeholder: 'Confira suas respostas:\n\n{resumo}\n\n1. Confirmar\n2. Corrigir\n3. Encerrar',
    variables: '{resumo}, {fluxo}',
  },
  {
    key: 'completed',
    label: 'Dados confirmados e salvos',
    help: 'Enviada depois que a confirmação final é gravada com sucesso.',
    placeholder: 'Dados confirmados e salvos.',
    variables: '{fluxo}',
  },
  {
    key: 'existingCpfLinked',
    label: 'CPF já cadastrado e novo número vinculado',
    help: 'Enviada quando o CPF já pertence a um cadastro. O sistema vincula o novo WhatsApp e não duplica a pessoa.',
    placeholder:
      'Este CPF já possui cadastro. O novo número foi vinculado com sucesso e nenhum cadastro duplicado foi criado.\n\n{menu}',
    variables: '{menu}, {fluxo}',
  },
  {
    key: 'flowExpired',
    label: 'Cadastro expirado',
    help: 'Enviada quando o prazo entre respostas termina.',
    placeholder:
      'O prazo expirou. As respostas temporárias foram apagadas. Envie uma nova mensagem para começar novamente.',
    variables: '{fluxo}',
  },
  {
    key: 'humanStarted',
    label: 'Atendimento humano iniciado',
    help: 'Confirma que o bot entrou em modo silencioso.',
    placeholder: 'Atendimento humano iniciado. O bot ficará em silêncio até o encerramento.',
    variables: '{fluxo}',
  },
  {
    key: 'humanWarning',
    label: 'Aviso de inatividade',
    help: 'Enviada antes de fechar automaticamente o atendimento humano.',
    placeholder: 'Seu atendimento está sem atividade e será encerrado em {minutos} minutos.',
    variables: '{minutos}, {fluxo}',
  },
  {
    key: 'humanClosed',
    label: 'Atendimento humano encerrado',
    help: 'Usada no encerramento manual ou automático.',
    placeholder: 'O atendimento foi encerrado. Envie uma nova mensagem para abrir o menu novamente.',
    variables: '{fluxo}',
  },
  {
    key: 'conversationClosed',
    label: 'Conversa encerrada pelo usuário',
    help: 'Enviada ao escolher a opção de encerrar no menu.',
    placeholder: 'Atendimento encerrado. O menu só será exibido quando você enviar uma nova mensagem.',
    variables: '{fluxo}',
  },
  {
    key: 'interviewScheduled',
    label: 'Entrevista marcada — 1ª fase',
    help: 'Enviada quando um operador marca a entrevista simples da primeira fase.',
    placeholder: `✅ *Sua entrevista foi marcada com sucesso!*

{detalhes_agendamento}

Se precisar alterar, utilize a opção *Remarcar minha entrevista* no menu.`,
    variables:
      '{data}, {hora}, {local}, {endereco}, {link_google_maps}, {instrucao}, {responsavel}, {detalhes_agendamento}, {fluxo}',
  },
  {
    key: 'interviewScheduledPhase2',
    label: 'Entrevista marcada — 2ª fase',
    help: 'Enviada quando um operador marca a entrevista teste da segunda fase.',
    placeholder: `✅ *Você avançou para a 2ª fase!*

Sua *entrevista teste* foi marcada com sucesso.

{detalhes_agendamento}

Confira as informações e, se precisar alterar, utilize a opção *Remarcar minha entrevista* no menu.`,
    variables:
      '{data}, {hora}, {local}, {endereco}, {link_google_maps}, {instrucao}, {responsavel}, {detalhes_agendamento}, {fluxo}',
  },
  {
    key: 'interviewScheduledPhase3',
    label: 'Entrevista marcada — 3ª fase',
    help: 'Enviada quando um operador marca a entrevista com o DP da terceira fase.',
    placeholder: `🎉 *Você avançou para a 3ª fase!*

Sua *entrevista com o DP* foi marcada com sucesso.

{detalhes_agendamento}

Confira as informações e, se precisar alterar, utilize a opção *Remarcar minha entrevista* no menu.`,
    variables:
      '{data}, {hora}, {local}, {endereco}, {link_google_maps}, {instrucao}, {responsavel}, {detalhes_agendamento}, {fluxo}',
  },
  {
    key: 'interviewReminder',
    label: 'Lembrete do horário',
    help: 'Lembrete automático enviado no dia do compromisso.',
    placeholder:
      '⏰ *Lembrete da sua entrevista*\nSua entrevista é *hoje, às {hora}*.\n\n{detalhes_agendamento}\n\nEsperamos por você! 😊',
    variables:
      '{data}, {hora}, {local}, {endereco}, {link_google_maps}, {instrucao}, {responsavel}, {detalhes_agendamento}, {fluxo}',
  },
  {
    key: 'interviewCancelled',
    label: 'Horário cancelado',
    help: 'Enviada quando um agendamento confirmado é cancelado.',
    placeholder:
      '❌ *Sua entrevista foi cancelada*\n\n{detalhes_agendamento}\n\nEnvie uma nova mensagem para consultar os próximos horários disponíveis.',
    variables:
      '{data}, {hora}, {local}, {endereco}, {link_google_maps}, {instrucao}, {responsavel}, {detalhes_agendamento}, {fluxo}',
  },
  {
    key: 'interviewRescheduled',
    label: 'Horário reagendado',
    help: 'Informa o horário anterior e o substituto.',
    placeholder:
      '✅ *Sua entrevista foi reagendada com sucesso!*\n\n🕐 Horário anterior:\n*{horario_anterior}*\n\n📅 *Novo horário:*\n{detalhes_agendamento}\n\nConfira as novas informações acima.\nSe precisar fazer outra alteração, utilize a opção *Remarcar minha entrevista* no menu.',
    variables:
      '{horario_anterior}, {novo_horario}, {data}, {hora}, {local}, {endereco}, {link_google_maps}, {instrucao}, {responsavel}, {detalhes_agendamento}, {fluxo}',
  },
  {
    key: 'privacyDeleted',
    label: 'Dados excluídos',
    help: 'Confirma a exclusão definitiva aprovada pelo administrador.',
    placeholder:
      'Seus dados pessoais foram excluídos conforme solicitado. Para utilizar o atendimento novamente, será necessário realizar um novo cadastro.',
    variables: '{fluxo}',
  },
  {
    key: 'privacyAdminDeleted',
    label: 'Dados excluídos pelo administrador',
    help: 'Confirma a exclusão quando ela é executada diretamente por um administrador.',
    placeholder:
      'Seu cadastro e seus dados foram excluídos por um administrador. Para utilizar o atendimento novamente, será necessário realizar um novo cadastro.',
    variables: '{fluxo}',
  },
] as const;

const defaultSectorMenuMessage =
  '*{setor}*\nEscolha um fluxo:\n{fluxos}\n\nVocê também pode enviar uma palavra-chave do fluxo.';
const diagramVariableDescriptions: Record<string, string> = {
  '{setor}': 'nome do setor configurado para este número',
  '{fluxos}': 'lista numerada dos fluxos publicados',
  '{contexto}': 'explicação da finalidade e do uso dos dados',
  '{fluxo}': 'nome do fluxo selecionado pelo cliente',
  '{resumo}': 'respostas coletadas e formatadas para conferência',
  '{menu}': 'menu do cadastro existente, com as opções liberadas para a pessoa',
  '{minutos}': 'tempo configurado para o aviso ou encerramento',
  '{data}': 'data do compromisso no fuso horário do setor',
  '{hora}': 'horário do compromisso no fuso horário do setor',
  '{local}': 'nome do local exibido para o cliente',
  '{endereco}': 'endereço por escrito do local',
  '{link_google_maps}': 'link do Google Maps cadastrado no local',
  '{instrucao}': 'instrução definida na marcação do horário',
  '{responsavel}': 'pessoa para quem o cliente deve se apresentar',
  '{detalhes_agendamento}': 'bloco completo do compromisso; campos vazios são omitidos',
  '{horario_anterior}': 'data e hora anteriores ao reagendamento',
  '{novo_horario}': 'nova data e hora do compromisso',
};
function DiagramVariableLegend({ variables }: { variables: string }) {
  const tokens = [...new Set(variables.match(/\{[^}]+\}/g) ?? [])];
  if (!tokens.length) return null;
  return (
    <div className="diagram-variable-legend" aria-label="Valores automáticos disponíveis">
      {tokens.map(token => (
        <span key={token}>
          <code>{token}</code> {diagramVariableDescriptions[token] ?? 'valor preenchido automaticamente'}
        </span>
      ))}
    </div>
  );
}

const journeyMessageKeys = ['consent', 'review'] as const;
const automaticMessageGroups = [
  {
    id: 'registration',
    title: 'Cadastro e conversa',
    description: 'Confirmação, atualização, expiração e encerramento da conversa.',
    keys: ['completed', 'existingCpfLinked', 'updateConsent', 'flowExpired', 'conversationClosed'],
  },
  {
    id: 'human-service',
    title: 'Atendimento humano',
    description: 'Início, aviso de inatividade e encerramento do atendimento.',
    keys: ['humanStarted', 'humanWarning', 'humanClosed'],
  },
  {
    id: 'interviews',
    title: 'Entrevistas e agenda',
    description: 'Marcações por fase, lembrete, cancelamento e reagendamento.',
    keys: [
      'interviewScheduled',
      'interviewScheduledPhase2',
      'interviewScheduledPhase3',
      'interviewReminder',
      'interviewCancelled',
      'interviewRescheduled',
    ],
  },
  {
    id: 'privacy',
    title: 'Privacidade e exclusão',
    description: 'Confirmações relacionadas à exclusão dos dados pessoais.',
    keys: ['privacyDeleted', 'privacyAdminDeleted'],
  },
] as const;
type AutomaticMessageGroupId = (typeof automaticMessageGroups)[number]['id'];

const defaultRecordMenu = (): WorkflowRecordMenuConfig => ({
  title: '',
  actions: recordMenuActionDefaults.map(item => ({ action: item.action, label: item.label, enabled: true })),
});

const completeRecordMenu = (menu?: WorkflowRecordMenuConfig): WorkflowRecordMenuConfig => {
  if (!menu?.actions?.length) return defaultRecordMenu();
  const configured = menu?.actions ?? [];
  return {
    title: menu?.title ?? '',
    actions: [
      ...configured.filter(item => recordMenuActionDefaults.some(defaultItem => defaultItem.action === item.action)),
      ...recordMenuActionDefaults
        .filter(defaultItem => !configured.some(item => item.action === defaultItem.action))
        .map(item => ({
          action: item.action,
          label: item.label,
          enabled: item.action === 'VISUALIZAR_AGENDAMENTO' || item.action === 'REMARCAR_AGENDAMENTO',
        })),
    ],
  };
};

export default function RecruitmentCenter() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  useDocumentTitle('Central de Recrutamento');
  const { data: sessions = [], refetch: refetchSessions } = useSessionsQuery();
  const { role, isAdmin, canWrite } = useRole();
  const toast = useToast();
  const [sessionId, setSessionId] = useState('');
  const [tab, setTab] = useState<Tab>(
    () => recruitmentCenterTabFromQuery(searchParams.get('aba')) ?? defaultRecruitmentCenterTab(role),
  );

  useEffect(() => {
    if (role && !isRecruitmentCenterTabAllowed(role, tab)) setTab(defaultRecruitmentCenterTab(role));
  }, [role, tab]);
  useEffect(() => {
    if (searchParams.get('aba') === tab) return;
    const next = new URLSearchParams(searchParams);
    next.set('aba', tab);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, tab]);
  const [candidates, setCandidates] = useState<WorkflowRecord[]>([]);
  const [tickets, setTickets] = useState<WorkflowTicket[]>([]);
  const [humanTicketNotifications, setHumanTicketNotifications] = useState<
    Array<HumanTicketChange & { read: boolean }>
  >([]);
  const humanTicketSnapshot = useRef(new Map<string, HumanTicketSnapshot>());
  const humanTicketSnapshotReady = useRef(false);
  const seenHumanTicketNotifications = useRef(new Set<string>());
  const [search, setSearch] = useState('');
  const [candidateFlowFilter, setCandidateFlowFilter] = useState('all');
  const [candidateStatusFilter, setCandidateStatusFilter] = useState('all');
  const [candidateSort, setCandidateSort] = useState<TableSortState>({ columnId: 'name', direction: 'asc' });
  const [candidateColumnDrag, setCandidateColumnDrag] = useState<{ sourceId: string; overId: string } | null>(null);
  const [appointmentTableSort, setAppointmentTableSort] = useState<TableSortState>({
    columnId: 'startsAt',
    direction: 'asc',
  });
  const [ticketTableSort, setTicketTableSort] = useState<TableSortState>({
    columnId: 'lastRelevantAt',
    direction: 'desc',
  });
  const [resolvedPhones, setResolvedPhones] = useState<Record<string, string>>({});
  const phoneCacheRef = useRef<Record<string, string>>({});
  const [selected, setSelected] = useState<WorkflowRecord | null>(null);
  const [candidateEditing, setCandidateEditing] = useState(false);
  const [candidateEditData, setCandidateEditData] = useState<Record<string, unknown>>({});
  const [candidateEditBaseline, setCandidateEditBaseline] = useState<Record<string, unknown>>({});
  const [candidateEditVersion, setCandidateEditVersion] = useState(1);
  const [candidateSaving, setCandidateSaving] = useState(false);
  const [candidateContactEditingId, setCandidateContactEditingId] = useState<string | null>(null);
  const [candidateContactPhone, setCandidateContactPhone] = useState('');
  const [candidateContactSaving, setCandidateContactSaving] = useState(false);
  const [candidateContactPendingDelete, setCandidateContactPendingDelete] = useState<
    NonNullable<WorkflowRecord['linkedContacts']>[number] | null
  >(null);
  const [recalculatingProximity, setRecalculatingProximity] = useState(false);
  const [candidateRecruitment, setCandidateRecruitment] = useState<WorkflowRecruitmentApplication | null>(null);
  const [candidateRecruitmentApplications, setCandidateRecruitmentApplications] = useState<
    WorkflowRecruitmentApplication[]
  >([]);
  const [candidateRecruitmentEvents, setCandidateRecruitmentEvents] = useState<WorkflowRecruitmentEvent[]>([]);
  const [candidateRecruitmentLoading, setCandidateRecruitmentLoading] = useState(false);
  const [candidatePendingDelete, setCandidatePendingDelete] = useState<WorkflowRecord | null>(null);
  const [candidateAppointmentSlots, setCandidateAppointmentSlots] = useState<WorkflowSlot[]>([]);
  const [candidateAppointments, setCandidateAppointments] = useState<WorkflowAppointment[]>([]);
  const [candidateAppointmentTargetSlotId, setCandidateAppointmentTargetSlotId] = useState('');
  const [candidateAppointmentSaving, setCandidateAppointmentSaving] = useState(false);
  const [candidateProfileRefreshRevision, setCandidateProfileRefreshRevision] = useState(0);
  const [selectedTicket, setSelectedTicket] = useState<WorkflowTicket | null>(null);
  const [ticketEvents, setTicketEvents] = useState<WorkflowTicketEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [flows, setFlows] = useState<WorkflowInstance[]>([]);
  const [indicators, setIndicators] = useState<WorkflowIndicators | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<WorkflowHubRuntimeStatus | null>(null);
  const [runtimePendingAction, setRuntimePendingAction] = useState<'plugin' | 'session' | null>(null);
  const [runtimeActionSaving, setRuntimeActionSaving] = useState(false);
  const [outboxHealth, setOutboxHealth] = useState<WorkflowOutboxHealth | null>(null);
  const [outboxPendingAction, setOutboxPendingAction] = useState<{
    row: WorkflowOutboxHealth['unsent'][number];
    action: 'retry' | 'discard';
  } | null>(null);
  const [outboxActionSaving, setOutboxActionSaving] = useState(false);
  const [humanServiceTargetEnabled, setHumanServiceTargetEnabled] = useState<boolean | null>(null);
  const [humanServiceSaving, setHumanServiceSaving] = useState(false);
  const [selectedFlowId, setSelectedFlowId] = useState('');
  const [pendingEditorNavigation, setPendingEditorNavigation] = useState<{
    type: 'flow' | 'session';
    id: string;
  } | null>(null);
  const [draftFields, setDraftFields] = useState<WorkflowField[]>([]);
  const [draftDefinition, setDraftDefinition] = useState<WorkflowVersionDefinition>({});
  const [draftGraph, setDraftGraph] = useState<WorkflowGraphDefinition>(() => createLinearWorkflowGraph([]));
  const visualDraftGraph = useMemo(() => reconcileWorkflowGraph(draftGraph, draftFields), [draftFields, draftGraph]);
  const orderedFlowNodes = useMemo(() => orderWorkflowGraphNodes(visualDraftGraph), [visualDraftGraph]);
  const editableFlowNodes = useMemo(
    () => orderedFlowNodes.filter(node => node.type === 'question' || node.type === 'message'),
    [orderedFlowNodes],
  );
  const [draftFlowId, setDraftFlowId] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [editorHistory, setEditorHistory] = useState<{
    past: WorkflowEditorSnapshot[];
    future: WorkflowEditorSnapshot[];
  }>({ past: [], future: [] });
  const lastHistoryEdit = useRef({ at: 0, group: '' });
  const [savingDraft, setSavingDraft] = useState(false);
  const savingDraftRef = useRef(false);
  const editorSnapshot = JSON.stringify([sessionId, selectedFlowId, draftFields, draftDefinition, draftGraph]);
  const latestEditorSnapshot = useRef(editorSnapshot);
  useLayoutEffect(() => {
    latestEditorSnapshot.current = editorSnapshot;
  }, [editorSnapshot]);
  const [expandedFlowNodeId, setExpandedFlowNodeId] = useState<string | null>(null);
  const flowPointerDrag = useRef<{
    nodeId: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    title: string;
    subtitle: string;
    moved: boolean;
  } | null>(null);
  const [flowDragPreview, setFlowDragPreview] = useState<{
    nodeId: string;
    x: number;
    y: number;
    width: number;
    title: string;
    subtitle: string;
  } | null>(null);
  const [dragOverFlowNodeId, setDragOverFlowNodeId] = useState<string | null>(null);
  const dragOverFlowNodeIdRef = useRef<string | null>(null);
  const suppressFlowCardClickUntil = useRef(0);
  const clearFlowDrag = useCallback(() => {
    flowPointerDrag.current = null;
    setFlowDragPreview(null);
    dragOverFlowNodeIdRef.current = null;
    setDragOverFlowNodeId(null);
    document.body.classList.remove('workflow-card-dragging');
  }, []);
  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      const drag = flowPointerDrag.current;
      if (!drag) return;
      if (!drag.moved && hasPointerDragStarted(drag, event.clientX, event.clientY)) {
        drag.moved = true;
        document.body.classList.add('workflow-card-dragging');
      }
      if (drag.moved) {
        event.preventDefault();
        const position = workflowDragPreviewPosition(drag, event.clientX, event.clientY);
        setFlowDragPreview({
          nodeId: drag.nodeId,
          ...position,
          width: drag.width,
          title: drag.title,
          subtitle: drag.subtitle,
        });
      }
    };
    const finishPointer = () => {
      if (flowPointerDrag.current?.moved) suppressFlowCardClickUntil.current = Date.now() + 500;
      clearFlowDrag();
    };
    const clearOnVisibilityLoss = () => {
      if (document.visibilityState !== 'visible') clearFlowDrag();
    };
    window.addEventListener('pointermove', trackPointer, { capture: true, passive: false });
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', finishPointer);
    window.addEventListener('blur', clearFlowDrag);
    document.addEventListener('visibilitychange', clearOnVisibilityLoss);
    return () => {
      window.removeEventListener('pointermove', trackPointer, true);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
      window.removeEventListener('blur', clearFlowDrag);
      document.removeEventListener('visibilitychange', clearOnVisibilityLoss);
      document.body.classList.remove('workflow-card-dragging');
    };
  }, [clearFlowDrag]);
  const [slotDate, setSlotDate] = useState('');
  const [slotInterviewPhase, setSlotInterviewPhase] = useState<WorkflowInterviewPhase>('FASE_1_ENTREVISTA_SIMPLES');
  const [slotLocationId, setSlotLocationId] = useState('');
  const [slotLocation, setSlotLocation] = useState('');
  const [slotAddress, setSlotAddress] = useState('');
  const [slotInstruction, setSlotInstruction] = useState('');
  const [slotResponsible, setSlotResponsible] = useState('');
  const [slotMapsUrl, setSlotMapsUrl] = useState('');
  const [slotCapacity, setSlotCapacity] = useState(1);
  const [newLocationInternalName, setNewLocationInternalName] = useState('');
  const [newLocationName, setNewLocationName] = useState('');
  const [newLocationAddress, setNewLocationAddress] = useState('');
  const [newLocationMapsUrl, setNewLocationMapsUrl] = useState('');
  const [newLocationLatitude, setNewLocationLatitude] = useState('');
  const [newLocationLongitude, setNewLocationLongitude] = useState('');
  const [newLocationContacts, setNewLocationContacts] = useState<LocationContactDraft[]>([]);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [locationEditorOpen, setLocationEditorOpen] = useState(false);
  const [slots, setSlots] = useState<WorkflowSlot[]>([]);
  const [appointments, setAppointments] = useState<WorkflowAppointment[]>([]);
  const [appointmentStatusFilter, setAppointmentStatusFilter] = useState<'active' | 'history' | 'all'>('active');
  const [showPastSlots, setShowPastSlots] = useState(false);
  const [agendaLocationFilter, setAgendaLocationFilter] = useState('all');
  const [agendaSlotSort, setAgendaSlotSort] = useState<AgendaSlotSort>('date-asc');
  const [appointmentPendingReschedule, setAppointmentPendingReschedule] = useState<WorkflowAppointment | null>(null);
  const [appointmentTargetSlotId, setAppointmentTargetSlotId] = useState('');
  const [slotPendingDelete, setSlotPendingDelete] = useState<WorkflowSlot | null>(null);
  const [slotPendingEdit, setSlotPendingEdit] = useState<WorkflowSlot | null>(null);
  const [editSlotInstruction, setEditSlotInstruction] = useState('');
  const [editSlotResponsible, setEditSlotResponsible] = useState('');
  const [editSlotInterviewPhase, setEditSlotInterviewPhase] =
    useState<WorkflowInterviewPhase>('FASE_1_ENTREVISTA_SIMPLES');
  const [editSlotCapacity, setEditSlotCapacity] = useState(1);
  const [creatingSlot, setCreatingSlot] = useState(false);
  const [slotPendingReschedule, setSlotPendingReschedule] = useState<WorkflowSlot | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleLocationId, setRescheduleLocationId] = useState('');
  const [rescheduleLocation, setRescheduleLocation] = useState('');
  const [rescheduleAddress, setRescheduleAddress] = useState('');
  const [rescheduleInstruction, setRescheduleInstruction] = useState('');
  const [rescheduleResponsible, setRescheduleResponsible] = useState('');
  const [rescheduleInterviewPhase, setRescheduleInterviewPhase] =
    useState<WorkflowInterviewPhase>('FASE_1_ENTREVISTA_SIMPLES');
  const [rescheduleMapsUrl, setRescheduleMapsUrl] = useState('');
  const [rescheduleCapacity, setRescheduleCapacity] = useState(1);
  const [flowConfig, setFlowConfig] = useState<Partial<WorkflowInstance>>({});
  const [flowKeywordsText, setFlowKeywordsText] = useState('');
  const [messagesJson, setMessagesJson] = useState('{}');
  const [deletionRequests, setDeletionRequests] = useState<WorkflowDeletionRequest[]>([]);
  const [deletionRequestPendingApprove, setDeletionRequestPendingApprove] = useState<WorkflowDeletionRequest | null>(
    null,
  );
  const [department, setDepartment] = useState<WorkflowDepartment | null>(null);
  const [scheduleJson, setScheduleJson] = useState('{}');
  const [settingsBaseline, setSettingsBaseline] = useState({ flowId: '', snapshot: '' });
  const settingsSnapshot = JSON.stringify([flowConfig, flowKeywordsText, messagesJson]);
  const departmentSnapshot = JSON.stringify([department, scheduleJson]);
  const departmentBaseline = useRef('');
  const [savedDepartmentSnapshot, setSavedDepartmentSnapshot] = useState('');
  const [candidateColumnSaveState, setCandidateColumnSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  const [savingSettingsCard, setSavingSettingsCard] = useState<string | null>(null);
  const [expandedSettingsCards, setExpandedSettingsCards] = useState<SettingsCardId[]>([]);
  const [diagramGraphExpanded, setDiagramGraphExpanded] = useState(false);
  const [diagramEntryExpanded, setDiagramEntryExpanded] = useState(false);
  const [diagramConfirmationExpanded, setDiagramConfirmationExpanded] = useState(false);
  const [expandedAutomaticMessageGroups, setExpandedAutomaticMessageGroups] = useState<AutomaticMessageGroupId[]>([]);
  const candidateColumnSaveTimer = useRef<number | null>(null);
  const candidateColumnSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const candidateColumnSaveRevision = useRef(0);
  const currentDepartmentSnapshot = useRef(departmentSnapshot);
  useLayoutEffect(() => {
    currentDepartmentSnapshot.current = departmentSnapshot;
  }, [departmentSnapshot]);
  const settingsDirty =
    settingsBaseline.flowId === selectedFlowId &&
    Boolean(settingsBaseline.snapshot) &&
    settingsSnapshot !== settingsBaseline.snapshot;
  const departmentDirty = Boolean(savedDepartmentSnapshot) && departmentSnapshot !== savedDepartmentSnapshot;
  const agendaLocations = department?.schedule?.locations ?? [];
  useEffect(() => {
    if (!draftDirty && !settingsDirty && !departmentDirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [draftDirty, settingsDirty, departmentDirty]);
  const loadGate = useRef(new WorkflowRequestGate());
  const agendaGate = useRef(new WorkflowRequestGate());

  useLayoutEffect(() => {
    const currentLoadGate = loadGate.current;
    const currentAgendaGate = agendaGate.current;
    currentLoadGate.invalidate();
    currentAgendaGate.invalidate();
    setSelectedFlowId('');
    setFlows([]);
    setCandidates([]);
    setTickets([]);
    setHumanTicketNotifications([]);
    humanTicketSnapshot.current = new Map();
    humanTicketSnapshotReady.current = false;
    seenHumanTicketNotifications.current = new Set();
    setSelected(null);
    setDepartment(null);
    if (candidateColumnSaveTimer.current !== null) window.clearTimeout(candidateColumnSaveTimer.current);
    candidateColumnSaveTimer.current = null;
    candidateColumnSaveRevision.current += 1;
    setCandidateColumnSaveState('idle');
    departmentBaseline.current = '';
    setSavedDepartmentSnapshot('');
    setSettingsBaseline({ flowId: '', snapshot: '' });
    setIndicators(null);
    setRuntimeStatus(null);
    setOutboxHealth(null);
    setOutboxPendingAction(null);
    setDeletionRequests([]);
    return () => {
      currentLoadGate.invalidate();
      currentAgendaGate.invalidate();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId && sessions[0]) setSessionId(sessions[0].id);
  }, [sessionId, sessions]);
  useEffect(() => {
    phoneCacheRef.current = {};
    setResolvedPhones({});
    setCandidateRecruitmentApplications([]);
  }, [sessionId]);
  useEffect(() => {
    setExpandedSettingsCards([]);
    setDiagramGraphExpanded(false);
    setDiagramEntryExpanded(false);
    setDiagramConfirmationExpanded(false);
    setShowPastSlots(false);
  }, [sessionId, selectedFlowId]);

  const applyHumanTicketRefresh = (nextTickets: WorkflowTicket[]) => {
    const changes = humanTicketSnapshotReady.current
      ? detectHumanTicketChanges(humanTicketSnapshot.current, nextTickets)
      : [];
    humanTicketSnapshot.current = snapshotHumanTickets(nextTickets);
    humanTicketSnapshotReady.current = true;
    setTickets(nextTickets);
    const unseen = changes.filter(change => {
      if (seenHumanTicketNotifications.current.has(change.key)) return false;
      seenHumanTicketNotifications.current.add(change.key);
      return true;
    });
    if (!unseen.length) return;
    setHumanTicketNotifications(current =>
      [...unseen.map(change => ({ ...change, read: false })), ...current].slice(0, 30),
    );
    const newest = unseen[0];
    toast.info(
      newest.kind === 'new' ? 'Novo atendimento humano' : 'Atualização em atendimento humano',
      unseen.length > 1 ? `${unseen.length} novos eventos aguardam sua atenção.` : 'Abra a aba Atendimento Humano.',
    );
  };

  const load = async (options: { preserveEditor?: boolean } = {}) => {
    if (!sessionId) return;
    const isCurrent = loadGate.current.begin();
    setLoading(true);
    try {
      const [
        peopleResult,
        callsResult,
        flowsResult,
        indicatorsResult,
        departmentResult,
        recruitmentResult,
        runtimeStatusResult,
      ] = await Promise.allSettled([
        workflowHubApi.records(sessionId),
        workflowHubApi.tickets(sessionId),
        workflowHubApi.instances(sessionId),
        workflowHubApi.indicators(sessionId),
        workflowHubApi.department(sessionId),
        workflowHubApi.recruitmentApplications(sessionId),
        workflowHubApi.runtimeStatus(sessionId),
      ]);
      if (!isCurrent()) return;
      if (peopleResult.status === 'rejected') throw peopleResult.reason;
      const people = peopleResult.value;
      const peopleWithCachedPhones = people.map(person => ({
        ...person,
        phone: person.phone || phoneCacheRef.current[person.contactId] || null,
      }));
      setCandidates(peopleWithCachedPhones);
      if (callsResult.status === 'fulfilled') applyHumanTicketRefresh(callsResult.value);
      if (indicatorsResult.status === 'fulfilled') setIndicators(indicatorsResult.value);
      if (recruitmentResult.status === 'fulfilled') setCandidateRecruitmentApplications(recruitmentResult.value);
      if (runtimeStatusResult.status === 'fulfilled') setRuntimeStatus(runtimeStatusResult.value);
      if (departmentResult.status === 'fulfilled') {
        if (options.preserveEditor) {
          setDepartment(current =>
            current
              ? { ...current, humanServiceEnabled: departmentResult.value.humanServiceEnabled }
              : departmentResult.value,
          );
          if (departmentBaseline.current) {
            const [baselineDepartment, baselineSchedule] = JSON.parse(departmentBaseline.current) as [
              WorkflowDepartment,
              string,
            ];
            departmentBaseline.current = JSON.stringify([
              { ...baselineDepartment, humanServiceEnabled: departmentResult.value.humanServiceEnabled },
              baselineSchedule,
            ]);
            setSavedDepartmentSnapshot(departmentBaseline.current);
          }
        } else if (!departmentBaseline.current || currentDepartmentSnapshot.current === departmentBaseline.current) {
          setDepartment(departmentResult.value);
          const schedule = JSON.stringify(departmentResult.value.schedule ?? {}, null, 2);
          setScheduleJson(schedule);
          departmentBaseline.current = JSON.stringify([departmentResult.value, schedule]);
          setSavedDepartmentSnapshot(departmentBaseline.current);
        }
      }
      if (flowsResult.status === 'fulfilled' && !options.preserveEditor) {
        setFlows(flowsResult.value);
        setSelectedFlowId(current =>
          flowsResult.value.some(flow => flow.id === current) ? current : (flowsResult.value[0]?.id ?? ''),
        );
      }
      if (isAdmin || role === 'operator') {
        const [requests, health] = await Promise.all([
          isAdmin ? workflowHubApi.deletionRequests(sessionId).catch(() => null) : Promise.resolve(null),
          workflowHubApi.outboxHealth(sessionId).catch(() => null),
        ]);
        if (!isCurrent()) return;
        if (requests) setDeletionRequests(requests);
        if (health) setOutboxHealth(health);
      }
      setSelected(current => (current ? (peopleWithCachedPhones.find(item => item.id === current.id) ?? null) : null));
      const unresolved = peopleWithCachedPhones.filter(person => !person.phone && person.contactId.endsWith('@lid'));
      if (unresolved.length) {
        const found: Record<string, string> = {};
        for (let index = 0; index < unresolved.length; index += 8) {
          const batch = unresolved.slice(index, index + 8);
          const results = await Promise.all(
            batch.map(person =>
              contactApi.resolvePhone(sessionId, person.contactId).catch(() => ({
                contactId: person.contactId,
                phone: null,
              })),
            ),
          );
          if (!isCurrent()) return;
          for (const result of results) if (result.phone) found[result.contactId] = result.phone;
        }
        Object.assign(phoneCacheRef.current, found);
        setResolvedPhones(current => ({ ...current, ...found }));
        setCandidates(current =>
          current.map(person => ({ ...person, phone: person.phone || found[person.contactId] || null })),
        );
      }
    } catch (error) {
      if (isCurrent())
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar a Central de Recrutamento');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };
  const loadCurrentSession = useEffectEvent(() => {
    void load();
  });
  useEffect(() => {
    loadCurrentSession();
  }, [sessionId]);
  const activeTickets = useMemo(() => tickets.filter(ticket => ticket.status !== 'CHAMADO_ENCERRADO'), [tickets]);
  const selectedSession = useMemo(
    () => sessions.find(session => session.id === sessionId) ?? null,
    [sessionId, sessions],
  );
  const sessionActive = selectedSession ? isSessionStarted(selectedSession) : false;
  const candidateName = useCallback(
    (candidate: WorkflowRecord) =>
      String(
        candidate.data.nome ??
          candidate.data.nome_completo ??
          candidate.phone ??
          resolvedPhones[candidate.contactId] ??
          'Candidato',
      ),
    [resolvedPhones],
  );
  const formatPhone = useCallback((value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('55'))
      return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
    if (digits.length === 12 && digits.startsWith('55'))
      return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
    return digits ? `+${digits}` : 'Número indisponível';
  }, []);
  const displayContactId = useCallback(
    (contactId: string, storedPhone?: string | null) => {
      const phone = storedPhone || resolvedPhones[contactId];
      if (phone) return formatPhone(phone);
      if (contactId.includes('@c.us') || contactId.includes('@s.whatsapp.net'))
        return formatPhone(contactId.split('@')[0]);
      return 'Número ainda não identificado';
    },
    [formatPhone, resolvedPhones],
  );
  const candidateContact = useCallback(
    (candidate: WorkflowRecord) => {
      const flow = flows.find(item => item.id === candidate.instanceId);
      const version =
        flow?.versions.find(item => item.id === flow.currentVersionId) ??
        flow?.versions.find(item => item.status === 'PUBLICADA') ??
        flow?.versions[0];
      const informedPhone = Object.entries(candidate.data).find(
        ([key, value]) =>
          version?.fields.find(field => (field.answerKey ?? field.id) === key)?.type === 'phone' &&
          typeof value === 'string',
      )?.[1] as string | undefined;
      return displayContactId(candidate.contactId, candidate.phone || informedPhone);
    },
    [displayContactId, flows],
  );
  const candidateForTicket = (ticket: WorkflowTicket) => {
    const ticketIds = new Set([ticket.contactId, ticket.chatId].map(value => value.toLocaleLowerCase('pt-BR')));
    const ticketDigits = new Set(
      [ticket.contactId, ticket.chatId].map(value => value.split('@')[0].replace(/\D/g, '')).filter(Boolean),
    );
    return candidates.find(candidate => {
      if (ticketIds.has(candidate.contactId.toLocaleLowerCase('pt-BR'))) return true;
      const contactDigits = candidate.contactId.split('@')[0].replace(/\D/g, '');
      const phoneDigits = (candidate.phone ?? '').replace(/\D/g, '');
      return Boolean(
        (contactDigits && ticketDigits.has(contactDigits)) || (phoneDigits && ticketDigits.has(phoneDigits)),
      );
    });
  };
  const candidateForAppointment = (appointment: WorkflowAppointment) =>
    candidates.find(candidate => candidate.contactId === appointment.contactId);
  const appointmentContact = (appointment: WorkflowAppointment) => {
    const candidate = candidateForAppointment(appointment);
    return candidate
      ? `${candidateName(candidate)} — ${candidateContact(candidate)}`
      : displayContactId(appointment.contactId);
  };
  const visibleAppointments = appointments
    .filter(appointment =>
      appointmentStatusFilter === 'all'
        ? true
        : appointmentStatusFilter === 'active'
          ? appointment.status === 'CONFIRMADO'
          : appointment.status !== 'CONFIRMADO',
    )
    .sort((left, right) => {
      const value = (appointment: WorkflowAppointment): unknown => {
        if (appointmentTableSort.columnId === 'contact') return appointmentContact(appointment);
        if (appointmentTableSort.columnId === 'status') return appointment.status;
        if (appointmentTableSort.columnId === 'reminder')
          return appointment.reminderSentAt ? new Date(appointment.reminderSentAt) : null;
        return appointment.slot ? new Date(appointment.slot.startsAt) : null;
      };
      return compareTableValues(value(left), value(right), appointmentTableSort.direction);
    });
  const sortedTickets = [...tickets].sort((left, right) => {
    const value = (ticket: WorkflowTicket): unknown => {
      if (ticketTableSort.columnId === 'contact') {
        const candidate = candidateForTicket(ticket);
        return candidate ? candidateName(candidate) : displayContactId(ticket.contactId);
      }
      if (ticketTableSort.columnId === 'flow') return ticket.instance?.name ?? '';
      if (ticketTableSort.columnId === 'status') return ticket.status;
      return new Date(ticket.lastRelevantAt);
    };
    return compareTableValues(value(left), value(right), ticketTableSort.direction);
  });
  const currentAgendaSlots = slots.filter(slot => Date.parse(slot.startsAt) > Date.now());
  const pastAgendaSlots = slots.filter(slot => Date.parse(slot.startsAt) <= Date.now());
  const agendaLocationOptions = [...new Set(slots.map(slot => slot.location?.trim()).filter(Boolean) as string[])].sort(
    (left, right) => left.localeCompare(right, 'pt-BR'),
  );
  const visibleAgendaSlots = filterAndSortAgendaSlots(slots, {
    includePast: showPastSlots,
    location: agendaLocationFilter,
    sort: agendaSlotSort,
  });
  const recruitmentByCandidate = useMemo(() => {
    const byRecord = new Map<string, WorkflowRecruitmentApplication>();
    const byContact = new Map<string, WorkflowRecruitmentApplication>();
    for (const application of candidateRecruitmentApplications) {
      if (application.recordId) byRecord.set(application.recordId, application);
      byContact.set(`${application.instanceId}:${application.contactId}`, application);
    }
    return { byRecord, byContact };
  }, [candidateRecruitmentApplications]);
  const talentPoolRecordIds = useMemo(() => {
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (
        recruitmentByCandidate.byRecord.has(candidate.id) ||
        recruitmentByCandidate.byContact.has(`${candidate.instanceId}:${candidate.contactId}`)
      )
        continue;
      const flow = flows.find(item => item.id === candidate.instanceId);
      const currentDefinition =
        flow?.versions.find(version => version.id === flow.currentVersionId) ??
        flow?.versions.find(version => version.status === 'PUBLICADA');
      const recordDefinition = flow?.versions.find(version => version.id === candidate.definitionVersionId);
      const definition = currentDefinition?.fields.some(field => field.talentPoolOption)
        ? currentDefinition
        : recordDefinition;
      const selectedTalentPool = definition?.fields.some(field => {
        if (!field.talentPoolOption) return false;
        const value = candidate.data[field.answerKey ?? field.id];
        return Array.isArray(value) ? value.includes(field.talentPoolOption) : value === field.talentPoolOption;
      });
      if (selectedTalentPool) ids.add(candidate.id);
    }
    return ids;
  }, [candidates, flows, recruitmentByCandidate]);
  const activeCandidates = useMemo(
    () => candidates.filter(candidate => !talentPoolRecordIds.has(candidate.id)),
    [candidates, talentPoolRecordIds],
  );
  const candidateProcessApplication = useCallback(
    (candidate: WorkflowRecord) =>
      recruitmentByCandidate.byRecord.get(candidate.id) ??
      recruitmentByCandidate.byContact.get(`${candidate.instanceId}:${candidate.contactId}`),
    [recruitmentByCandidate],
  );
  const candidateProcessStatus = useCallback(
    (candidate: WorkflowRecord) => {
      const application = candidateProcessApplication(candidate);
      return application ? recruitmentStatusLabels[application.status] : 'Não iniciado';
    },
    [candidateProcessApplication],
  );
  const filteredCandidates = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('pt-BR');
    return activeCandidates
      .filter(candidate => candidateFlowFilter === 'all' || candidate.instanceId === candidateFlowFilter)
      .filter(candidate => candidateStatusFilter === 'all' || candidate.status === candidateStatusFilter)
      .filter(candidate => {
        if (!needle) return true;
        return `${candidateName(candidate)} ${candidate.phone ?? ''} ${candidate.contactId} ${candidate.instanceName} ${candidate.status} ${candidateProcessStatus(candidate)} ${JSON.stringify(candidate.data)}`
          .toLocaleLowerCase('pt-BR')
          .includes(needle);
      })
      .sort((left, right) => {
        const rawValue = (candidate: WorkflowRecord): unknown => {
          if (candidateSort.columnId === 'name') return candidateName(candidate);
          if (candidateSort.columnId === 'contact') return candidateContact(candidate);
          if (candidateSort.columnId === 'flow') return candidate.instanceName;
          if (candidateSort.columnId === 'status') return candidate.status;
          if (candidateSort.columnId === 'processStatus') return candidateProcessStatus(candidate);
          if (candidateSort.columnId === 'updated') return new Date(candidate.updatedAt);
          const answerKey = candidateSort.columnId.startsWith('answer:')
            ? candidateSort.columnId.slice('answer:'.length)
            : '';
          const value = candidate.data[answerKey];
          return Array.isArray(value) ? value.join(', ') : value;
        };
        return compareTableValues(rawValue(left), rawValue(right), candidateSort.direction);
      });
  }, [
    activeCandidates,
    candidateFlowFilter,
    candidateSort,
    candidateStatusFilter,
    search,
    candidateName,
    candidateProcessStatus,
    candidateContact,
  ]);
  const markFlowCardAsSaved = (saved: WorkflowInstance, keys: Array<keyof WorkflowInstance>) => {
    setSettingsBaseline(current => {
      if (current.flowId !== saved.id || !current.snapshot) return current;
      try {
        const [savedConfig, savedKeywords, savedMessages] = JSON.parse(current.snapshot) as [
          Partial<WorkflowInstance>,
          string,
          string,
        ];
        const nextConfig = { ...savedConfig };
        keys.forEach(key => {
          Object.assign(nextConfig, { [key]: saved[key] });
        });
        return { ...current, snapshot: JSON.stringify([nextConfig, savedKeywords, savedMessages]) };
      } catch {
        return current;
      }
    });
  };
  const saveFlowSettingsCard = async (
    card: string,
    patch: Partial<WorkflowInstance>,
    keys: Array<keyof WorkflowInstance>,
    successMessage: string,
  ) => {
    if (!selectedFlow) return;
    setSavingSettingsCard(card);
    try {
      const saved = await workflowHubApi.update(sessionId, selectedFlow.id, patch);
      markFlowCardAsSaved(saved, keys);
      setFlows(current => current.map(flow => (flow.id === saved.id ? saved : flow)));
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar esta configuração');
    } finally {
      setSavingSettingsCard(current => (current === card ? null : current));
    }
  };
  const saveDepartmentSettings = async () => {
    if (!department) return;
    const editedSchedule = scheduleJson;
    const editedValues = {
      name: department.name,
      timezone: department.timezone,
      menuTimeoutMinutes: department.menuTimeoutMinutes,
    };
    setSavingSettingsCard('department');
    try {
      const schedule = JSON.parse(editedSchedule);
      const saved = await workflowHubApi.updateDepartment(sessionId, { ...editedValues, schedule });
      const savedSchedule = JSON.stringify(saved.schedule ?? {}, null, 2);
      if (departmentBaseline.current) {
        const [previousDepartment] = JSON.parse(departmentBaseline.current) as [WorkflowDepartment, string];
        departmentBaseline.current = JSON.stringify([
          {
            ...previousDepartment,
            name: saved.name,
            timezone: saved.timezone,
            menuTimeoutMinutes: saved.menuTimeoutMinutes,
            schedule: saved.schedule,
          },
          savedSchedule,
        ]);
        setSavedDepartmentSnapshot(departmentBaseline.current);
      }
      setDepartment(current => {
        if (!current) return current;
        const unchanged =
          current.name === editedValues.name &&
          current.timezone === editedValues.timezone &&
          current.menuTimeoutMinutes === editedValues.menuTimeoutMinutes;
        return unchanged
          ? {
              ...current,
              name: saved.name,
              timezone: saved.timezone,
              menuTimeoutMinutes: saved.menuTimeoutMinutes,
              schedule: saved.schedule,
            }
          : current;
      });
      setScheduleJson(current => (current === editedSchedule ? savedSchedule : current));
      toast.success('Setor e horários de atendimento salvos');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o setor e os horários.');
    } finally {
      setSavingSettingsCard(current => (current === 'department' ? null : current));
    }
  };
  const saveDiagramMessages = async () => {
    if (!selectedFlow) return;
    try {
      const messages = JSON.parse(messagesJson) as Record<string, string>;
      const recordMenu = completeRecordMenu(flowConfig.recordMenu);
      if (!recordMenu.actions.some(item => item.enabled)) throw new Error('Ative pelo menos uma ação no menu.');
      const appointmentNotifications = (flowConfig.appointmentNotifications ?? []).map((recipient, index) => {
        const ddi = recipient.ddi.replace(/\D/g, '');
        const ddd = recipient.ddd.replace(/\D/g, '');
        const number = recipient.number.replace(/\D/g, '');
        if (!ddi || !ddd || !number) throw new Error(`Preencha DDI, DDD e número no destinatário ${index + 1}.`);
        if (!recipient.name.trim()) throw new Error(`Informe o nome do gestor ${index + 1}.`);
        if (!recipient.events.length) throw new Error(`Escolha ao menos um evento no destinatário ${index + 1}.`);
        return {
          ...recipient,
          name: recipient.name.trim(),
          ddi,
          ddd,
          number,
          locationIds: [...new Set(recipient.locationIds ?? [])],
          interviewPhases: [...new Set(recipient.interviewPhases ?? [])],
          enabled: recipient.enabled !== false,
        };
      });
      await workflowHubApi.update(sessionId, selectedFlow.id, {
        name: flowConfig.name,
        keywords: flowKeywordsText
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
        appointmentNotifications,
        messages,
        recordMenu,
      });
      setSettingsBaseline({ flowId: selectedFlow.id, snapshot: settingsSnapshot });
      if (department) {
        await workflowHubApi.updateDepartment(sessionId, { messages: department.messages });
        if (departmentBaseline.current) {
          const [previousDepartment, previousSchedule] = JSON.parse(departmentBaseline.current);
          departmentBaseline.current = JSON.stringify([
            { ...previousDepartment, messages: department.messages },
            previousSchedule,
          ]);
          setSavedDepartmentSnapshot(departmentBaseline.current);
        }
      }
      toast.success('Configurações da conversa salvas');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar as mensagens');
    }
  };
  const closeTicket = async (ticket: WorkflowTicket) => {
    await workflowHubApi.closeTicket(sessionId, ticket.id);
    toast.success('Chamado encerrado');
    await load();
  };
  const touchTicket = async (ticket: WorkflowTicket) => {
    await workflowHubApi.touchTicket(sessionId, ticket.id);
    toast.success('Prazo do chamado reiniciado');
    await load();
  };
  const showTicketEvents = async (ticket: WorkflowTicket) => {
    setSelectedTicket(ticket);
    try {
      setTicketEvents(await workflowHubApi.ticketEvents(sessionId, ticket.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar o histórico');
    }
  };
  const downloadCandidateFile = async (candidate: WorkflowRecord, value: Record<string, unknown>) => {
    try {
      const messageId = String(value.waMessageId ?? '');
      if (!messageId) throw new Error('A referência do arquivo não está disponível.');
      const blob = await sessionApi.getMessageMediaBlob(sessionId, candidate.contactId, messageId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = String(value.filename ?? 'curriculo.pdf');
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao baixar o arquivo');
    }
  };
  const renderCandidateValue = (candidate: WorkflowRecord, value: unknown) => {
    if (value === '__OPENWA_SKIPPED__') return 'Não informado (optou por pular)';
    if (typeof value === 'boolean')
      return <span className={`answer-boolean ${value ? 'yes' : 'no'}`}>{value ? 'Sim' : 'Não'}</span>;
    if (value && typeof value === 'object' && 'waMessageId' in value) {
      const file = value as Record<string, unknown>;
      return (
        <button className="btn-secondary" onClick={() => void downloadCandidateFile(candidate, file)}>
          <Download size={15} /> {String(file.filename ?? 'Baixar arquivo')}
        </button>
      );
    }
    if (Array.isArray(value)) return value.join(', ');
    return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  };
  const candidateFieldLabel = useCallback(
    (candidate: WorkflowRecord, key: string) => {
      const flow = flows.find(item => item.id === candidate.instanceId);
      const version =
        flow?.versions.find(item => item.id === flow.currentVersionId) ??
        flow?.versions.find(item => item.status === 'PUBLICADA') ??
        flow?.versions[0];
      return version?.fields.find(field => (field.answerKey ?? field.id) === key)?.label ?? key;
    },
    [flows],
  );
  const candidateDefinitionFields = useCallback(
    (candidate: WorkflowRecord) => {
      const flow = flows.find(item => item.id === candidate.instanceId);
      const version =
        flow?.versions.find(item => item.id === flow.currentVersionId) ??
        flow?.versions.find(item => item.status === 'PUBLICADA') ??
        flow?.versions[0];
      const seen = new Set<string>();
      return [...(version?.fields ?? [])]
        .sort((left, right) => left.order - right.order)
        .filter(field => {
          const key = field.answerKey ?? field.id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },
    [flows],
  );
  const candidateFieldIsVisible = useCallback(
    (field: WorkflowField, fields: WorkflowField[], data: Record<string, unknown>) => {
      if (!field.visibleWhen) return true;
      const source = fields.find(item => item.id === field.visibleWhen?.fieldId);
      const current = data[source ? (source.answerKey ?? source.id) : field.visibleWhen.fieldId];
      const expected = field.visibleWhen.value;
      if (field.visibleWhen.operator === 'filled')
        return current !== undefined && current !== null && current !== '' && current !== '__OPENWA_SKIPPED__';
      if (field.visibleWhen.operator === 'contains')
        return Array.isArray(current)
          ? current.includes(expected)
          : String(current ?? '')
              .toLocaleLowerCase('pt-BR')
              .includes(String(expected ?? '').toLocaleLowerCase('pt-BR'));
      if (field.visibleWhen.operator === 'notEquals') return String(current ?? '') !== String(expected ?? '');
      return String(current ?? '') === String(expected ?? '');
    },
    [],
  );
  const candidateFieldType = (candidate: WorkflowRecord, key: string) => {
    const flow = flows.find(item => item.id === candidate.instanceId);
    const version =
      flow?.versions.find(item => item.id === flow.currentVersionId) ??
      flow?.versions.find(item => item.status === 'PUBLICADA') ??
      flow?.versions[0];
    return version?.fields.find(field => (field.answerKey ?? field.id) === key)?.type;
  };
  const renderCandidateAnswer = (candidate: WorkflowRecord, key: string, value: unknown) => {
    const fieldType = candidateFieldType(candidate, key);
    if (fieldType === 'consent' && (typeof value === 'boolean' || value === 'true' || value === 'false')) {
      const accepted = value === true || value === 'true';
      return <span className={`answer-boolean ${accepted ? 'yes' : 'no'}`}>{accepted ? 'Sim' : 'Não'}</span>;
    }
    if (fieldType === 'appointment' && typeof value === 'string') {
      const slot = candidateAppointmentSlots.find(item => item.id === value);
      return slot ? (
        <span className="appointment-answer">
          {new Date(slot.startsAt).toLocaleString('pt-BR')}
          {slot.location ? ` — ${slot.location}` : ''}
        </span>
      ) : (
        'Horário selecionado (não está mais disponível na agenda)'
      );
    }
    if (fieldType === 'cpf') return formatCpf(value);
    return renderCandidateValue(candidate, value);
  };
  const renderCandidateEditor = (field: WorkflowField) => {
    const key = field.answerKey ?? field.id;
    const storedValue = candidateEditData[key];
    const value = storedValue === '__OPENWA_SKIPPED__' ? '' : storedValue;
    if (field.type === 'pdf' || field.type === 'appointment')
      return (
        <div className="candidate-readonly-answer">{selected && renderCandidateAnswer(selected, key, storedValue)}</div>
      );
    if (field.type === 'textarea')
      return (
        <textarea
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={event => setCandidateEditData(current => ({ ...current, [key]: event.target.value }))}
          rows={3}
        />
      );
    if (field.type === 'select')
      return (
        <select
          aria-label={field.label}
          value={String(value ?? '')}
          onChange={event => setCandidateEditData(current => ({ ...current, [key]: event.target.value }))}
        >
          {!field.required && <option value="">Não informado</option>}
          {field.options?.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    if (field.type === 'multiselect') {
      const selectedValues = Array.isArray(value) ? value.map(String) : [];
      return (
        <select
          aria-label={field.label}
          multiple
          value={selectedValues}
          onChange={event =>
            setCandidateEditData(current => ({
              ...current,
              [key]: [...event.target.selectedOptions].map(option => option.value),
            }))
          }
        >
          {field.options?.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    if (field.type === 'consent')
      return (
        <select
          aria-label={field.label}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={event =>
            setCandidateEditData(current => ({
              ...current,
              [key]: event.target.value === '' ? '' : event.target.value === 'true',
            }))
          }
        >
          {!field.required && <option value="">Não informado</option>}
          <option value="true">Sim</option>
          <option value="false">Não</option>
        </select>
      );
    const inputType =
      field.type === 'email'
        ? 'email'
        : field.type === 'number' || field.type === 'currency'
          ? 'number'
          : field.type === 'date'
            ? 'date'
            : field.type === 'phone'
              ? 'tel'
              : 'text';
    return (
      <input
        aria-label={field.label}
        type={inputType}
        value={String(value ?? '')}
        min={field.type === 'number' || field.type === 'currency' ? field.min : undefined}
        max={field.type === 'number' || field.type === 'currency' ? field.max : undefined}
        inputMode={field.type === 'cpf' ? 'numeric' : undefined}
        maxLength={field.type === 'cpf' ? 14 : undefined}
        onChange={event =>
          setCandidateEditData(current => ({
            ...current,
            [key]: field.type === 'cpf' ? formatCpf(event.target.value) : event.target.value,
          }))
        }
      />
    );
  };
  const { availableCandidateColumns, candidateColumnLegacyAliases } = useMemo(() => {
    const fixed: CandidateColumn[] = [
      { id: 'name', label: 'Nome', kind: 'fixed' },
      { id: 'contact', label: 'Contato', kind: 'fixed' },
      { id: 'flow', label: 'Fluxo', kind: 'fixed' },
      { id: 'status', label: 'Status', kind: 'fixed' },
      { id: 'processStatus', label: 'Status do processo', kind: 'fixed' },
      { id: 'updated', label: 'Atualizado em', kind: 'fixed' },
    ];
    const answers = new Map<string, string>();
    const knownAnswerKeys = new Set<string>();
    const legacyAliases = new Map<string, string>();
    for (const flow of flows) {
      const version =
        flow.versions.find(item => item.status === 'RASCUNHO') ??
        flow.versions.find(item => item.id === flow.currentVersionId) ??
        [...flow.versions].sort((left, right) => right.versionNumber - left.versionNumber)[0];
      for (const historicalVersion of flow.versions) {
        for (const historicalField of historicalVersion.fields)
          knownAnswerKeys.add(historicalField.answerKey ?? historicalField.id);
      }
      for (const field of version?.fields ?? []) {
        const answerKey = field.answerKey ?? field.id;
        if (!answers.has(answerKey)) answers.set(answerKey, field.label);
        for (const historicalVersion of flow.versions) {
          const historicalField = historicalVersion.fields.find(item => item.id === field.id);
          if (!historicalField) continue;
          const historicalAnswerKey = historicalField.answerKey ?? historicalField.id;
          if (historicalAnswerKey !== answerKey)
            legacyAliases.set(`answer:${historicalAnswerKey}`, `answer:${answerKey}`);
        }
      }
    }
    for (const candidate of candidates) {
      for (const key of Object.keys(candidate.data)) {
        // Unknown historical/custom fields remain available. Keys known to have belonged to a
        // renamed or removed schema field do not return as orphan columns from old records.
        if (!knownAnswerKeys.has(key)) answers.set(key, candidateFieldLabel(candidate, key));
      }
    }
    return {
      availableCandidateColumns: [
        ...fixed,
        ...[...answers.entries()].map(([answerKey, label]) => ({
          id: `answer:${answerKey}`,
          label,
          kind: 'answer' as const,
          answerKey,
        })),
      ] satisfies CandidateColumn[],
      candidateColumnLegacyAliases: legacyAliases,
    };
  }, [candidates, candidateFieldLabel, flows]);
  const candidateColumnPreferences = useMemo(
    () =>
      reconcileCandidateColumnPreferences(
        availableCandidateColumns,
        department?.candidateTableColumns,
        candidateColumnLegacyAliases,
      ),
    [availableCandidateColumns, candidateColumnLegacyAliases, department?.candidateTableColumns],
  );
  const visibleCandidateColumns = candidateColumnPreferences
    .filter(preference => preference.visible)
    .map(preference => availableCandidateColumns.find(column => column.id === preference.id))
    .filter((column): column is CandidateColumn => Boolean(column));
  const queueCandidateColumnSave = (next: CandidateColumnPreference[], revision: number, notifyOnSuccess = false) => {
    const persist = async () => {
      try {
        const saved = await workflowHubApi.updateDepartment(sessionId, { candidateTableColumns: next });
        if (revision !== candidateColumnSaveRevision.current) return;
        setDepartment(current =>
          current ? { ...current, candidateTableColumns: saved.candidateTableColumns } : current,
        );
        if (departmentBaseline.current) {
          const [previousDepartment, previousSchedule] = JSON.parse(departmentBaseline.current);
          departmentBaseline.current = JSON.stringify([
            { ...previousDepartment, candidateTableColumns: saved.candidateTableColumns },
            previousSchedule,
          ]);
          setSavedDepartmentSnapshot(departmentBaseline.current);
        }
        setCandidateColumnSaveState('saved');
        if (notifyOnSuccess) toast.success('Campos da tabela salvos');
      } catch (error) {
        if (revision !== candidateColumnSaveRevision.current) return;
        setCandidateColumnSaveState('error');
        toast.error(error instanceof Error ? error.message : 'Não foi possível salvar os campos da tabela.');
      }
    };
    // Preserve click order even when the network responds out of order. The last edit is always
    // the last database write, and a rejected request does not break subsequent saves.
    candidateColumnSaveQueue.current = candidateColumnSaveQueue.current.then(persist, persist);
    return candidateColumnSaveQueue.current;
  };
  const updateCandidateColumnPreferences = (next: CandidateColumnPreference[]) => {
    setDepartment(current => (current ? { ...current, candidateTableColumns: next } : current));
    if (candidateColumnSaveTimer.current !== null) window.clearTimeout(candidateColumnSaveTimer.current);
    const revision = ++candidateColumnSaveRevision.current;
    setCandidateColumnSaveState('saving');
    candidateColumnSaveTimer.current = window.setTimeout(() => {
      candidateColumnSaveTimer.current = null;
      void queueCandidateColumnSave(next, revision);
    }, 350);
  };
  const saveCandidateColumns = () => {
    if (candidateColumnSaveTimer.current !== null) window.clearTimeout(candidateColumnSaveTimer.current);
    candidateColumnSaveTimer.current = null;
    const revision = ++candidateColumnSaveRevision.current;
    setCandidateColumnSaveState('saving');
    void queueCandidateColumnSave(candidateColumnPreferences, revision, true);
  };
  const moveCandidateColumn = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= candidateColumnPreferences.length) return;
    const next = [...candidateColumnPreferences];
    [next[index], next[target]] = [next[target], next[index]];
    updateCandidateColumnPreferences(next);
  };
  const dropCandidateColumn = (targetId: string) => {
    if (!candidateColumnDrag) return;
    const next = reorderCandidateColumnPreferences(candidateColumnPreferences, candidateColumnDrag.sourceId, targetId);
    setCandidateColumnDrag(null);
    if (next !== candidateColumnPreferences) updateCandidateColumnPreferences(next);
  };
  const selectedCandidateInstanceId = selected?.instanceId;
  const selectedCandidateId = selected?.id;
  const selectedCandidateContactId = selected?.contactId;
  const resetCandidateEditor = useEffectEvent(() => {
    setCandidateEditing(false);
    setCandidateEditData(selected?.data ?? {});
    setCandidateEditBaseline(selected?.data ?? {});
    setCandidateEditVersion(selected?.currentVersion ?? 1);
    setCandidateSaving(false);
  });
  const selectedCandidateFields = useMemo(() => {
    if (!selected) return [];
    const fields = candidateDefinitionFields(selected);
    const source = candidateEditing ? candidateEditData : selected.data;
    return fields.filter(field => candidateFieldIsVisible(field, fields, source));
  }, [candidateDefinitionFields, candidateEditData, candidateEditing, candidateFieldIsVisible, selected]);
  const selectedCandidateLegacyAnswers = useMemo(() => {
    if (!selected) return [];
    const currentKeys = new Set(selectedCandidateFields.map(field => field.answerKey ?? field.id));
    return Object.entries(selected.data).filter(([key]) => !currentKeys.has(key));
  }, [selected, selectedCandidateFields]);
  const pendingCandidateProximityKey = useMemo(
    () =>
      candidates
        .filter(candidate => candidate.proximityStatus === 'PENDENTE' || candidate.proximityStatus === 'PROCESSANDO')
        .map(candidate => candidate.id)
        .sort()
        .join(','),
    [candidates],
  );
  useEffect(() => {
    resetCandidateEditor();
  }, [selectedCandidateId]);
  useEffect(() => {
    if (!selectedCandidateId || !selectedCandidateInstanceId || !selectedCandidateContactId) {
      setCandidateRecruitment(null);
      setCandidateRecruitmentEvents([]);
      setCandidateRecruitmentLoading(false);
      return;
    }
    let active = true;
    setCandidateRecruitment(null);
    setCandidateRecruitmentEvents([]);
    setCandidateRecruitmentLoading(true);
    void workflowHubApi
      .recruitmentApplications(sessionId)
      .then(async applications => {
        const application = applications.find(
          item =>
            item.recordId === selectedCandidateId ||
            (item.instanceId === selectedCandidateInstanceId && item.contactId === selectedCandidateContactId),
        );
        if (!active) return;
        setCandidateRecruitment(application ?? null);
        if (!application) return;
        const events = await workflowHubApi.recruitmentEvents(sessionId, application.id);
        if (active) setCandidateRecruitmentEvents(events);
      })
      .catch(error => {
        if (active) toast.error(error instanceof Error ? error.message : 'Falha ao carregar o processo do candidato');
      })
      .finally(() => {
        if (active) setCandidateRecruitmentLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    candidateProfileRefreshRevision,
    selectedCandidateContactId,
    selectedCandidateId,
    selectedCandidateInstanceId,
    sessionId,
    toast,
  ]);
  useEffect(() => {
    if (!sessionId || !pendingCandidateProximityKey) return;
    let active = true;
    const refreshProximity = async () => {
      try {
        const records = await workflowHubApi.records(sessionId);
        if (!active) return;
        const byId = new Map(records.map(record => [record.id, record]));
        setCandidates(current =>
          current.map(record => {
            const updated = byId.get(record.id);
            return updated ? { ...record, ...updated, phone: updated.phone || record.phone } : record;
          }),
        );
        setSelected(current => {
          if (!current) return current;
          const updated = byId.get(current.id);
          return updated ? { ...current, ...updated, phone: updated.phone || current.phone } : current;
        });
      } catch {
        // The regular page refresh remains the fallback for a transient polling failure.
      }
    };
    void refreshProximity();
    const timer = window.setInterval(() => void refreshProximity(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pendingCandidateProximityKey, sessionId]);
  useEffect(() => {
    let ignore = false;
    if (!selectedCandidateInstanceId) {
      setCandidateAppointmentSlots([]);
      setCandidateAppointments([]);
      setCandidateAppointmentTargetSlotId('');
      return;
    }
    setCandidateAppointmentTargetSlotId('');
    void Promise.all([
      workflowHubApi.slots(sessionId, selectedCandidateInstanceId),
      workflowHubApi.appointments(sessionId, selectedCandidateInstanceId),
    ])
      .then(([slotRows, appointmentRows]) => {
        if (ignore) return;
        setCandidateAppointmentSlots(slotRows);
        setCandidateAppointments(appointmentRows.filter(item => item.contactId === selectedCandidateContactId));
      })
      .catch(() => {
        if (ignore) return;
        setCandidateAppointmentSlots([]);
        setCandidateAppointments([]);
      });
    return () => {
      ignore = true;
    };
  }, [candidateProfileRefreshRevision, selectedCandidateContactId, selectedCandidateInstanceId, sessionId]);
  const candidateCurrentAppointment = candidateAppointments.find(item => item.status === 'CONFIRMADO') ?? null;
  const candidateAvailableSlots = candidateAppointmentSlots.filter(
    slot =>
      slot.id !== candidateCurrentAppointment?.slot?.id &&
      slot.status === 'DISPONIVEL' &&
      slot.bookedCount < slot.capacity &&
      Date.parse(slot.startsAt) > Date.now(),
  );
  const saveCandidateAppointment = async () => {
    if (!selected || !candidateAppointmentTargetSlotId || candidateAppointmentSaving) return;
    setCandidateAppointmentSaving(true);
    try {
      if (candidateCurrentAppointment)
        await workflowHubApi.rescheduleAppointment(
          sessionId,
          selected.instanceId,
          candidateCurrentAppointment.id,
          candidateAppointmentTargetSlotId,
        );
      else
        await workflowHubApi.scheduleRecordAppointment(
          sessionId,
          selected.instanceId,
          selected.id,
          candidateAppointmentTargetSlotId,
        );
      setCandidateAppointmentTargetSlotId('');
      setCandidateProfileRefreshRevision(current => current + 1);
      toast.success(
        candidateCurrentAppointment
          ? 'Entrevista reagendada e aviso preparado para o candidato.'
          : 'Entrevista marcada e aviso preparado para o candidato.',
      );
      await load({ preserveEditor: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível atualizar a entrevista.');
    } finally {
      setCandidateAppointmentSaving(false);
    }
  };
  const candidateTableValue = (candidate: WorkflowRecord, column: CandidateColumn) => {
    if (column.id === 'name') return candidateName(candidate);
    if (column.id === 'contact') return candidateContact(candidate);
    if (column.id === 'flow') return candidate.instanceName || '—';
    if (column.id === 'status') return candidate.status;
    if (column.id === 'processStatus') return candidateProcessStatus(candidate);
    if (column.id === 'updated') return new Date(candidate.updatedAt).toLocaleString('pt-BR');
    const value = candidate.data[column.answerKey ?? ''];
    if (value === '__OPENWA_SKIPPED__') return 'Não informado';
    if (Array.isArray(value)) return value.join(', ');
    if (value && typeof value === 'object') return 'Arquivo/dado disponível no perfil';
    if (column.answerKey && candidateFieldType(candidate, column.answerKey) === 'cpf') return formatCpf(value);
    return String(value ?? '—');
  };
  const candidateTableStatus = (candidate: WorkflowRecord, column: CandidateColumn) =>
    column.id === 'processStatus'
      ? (candidateProcessApplication(candidate)?.status ?? 'NAO_INICIADO')
      : candidate.status;
  const selectedFlow = flows.find(flow => flow.id === selectedFlowId);
  const hasDraftVersion = Boolean(selectedFlow?.versions.some(version => version.status === 'RASCUNHO'));
  const configuredMessages = useMemo<Record<string, string>>(() => {
    try {
      const parsed = JSON.parse(messagesJson) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }, [messagesJson]);
  const updateConfiguredMessage = (key: string, value: string) => {
    const next = { ...configuredMessages };
    if (value.trim()) next[key] = value;
    else delete next[key];
    setMessagesJson(JSON.stringify(next, null, 2));
  };
  const recordMenuConfig = completeRecordMenu(flowConfig.recordMenu);
  const updateRecordMenu = (next: WorkflowRecordMenuConfig) =>
    setFlowConfig(current => ({ ...current, recordMenu: next }));
  const updateRecordMenuAction = (index: number, patch: Partial<WorkflowRecordMenuConfig['actions'][number]>) => {
    const actions = recordMenuConfig.actions.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...patch } : item,
    );
    updateRecordMenu({ ...recordMenuConfig, actions });
  };
  const moveRecordMenuAction = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= recordMenuConfig.actions.length) return;
    const actions = [...recordMenuConfig.actions];
    [actions[index], actions[target]] = [actions[target], actions[index]];
    updateRecordMenu({ ...recordMenuConfig, actions });
  };
  const hydrateFlowSettings = useEffectEvent(() => {
    if (!selectedFlow) return;
    if (settingsBaseline.flowId === selectedFlowId && settingsDirty) return;
    const messages = JSON.stringify(selectedFlow.messages ?? {}, null, 2);
    const keywords = selectedFlow.keywords.join(', ');
    const config = {
      name: selectedFlow.name,
      description: selectedFlow.description,
      keywords: selectedFlow.keywords,
      flowTimeoutMinutes: selectedFlow.flowTimeoutMinutes,
      invalidAttemptLimit: selectedFlow.invalidAttemptLimit,
      humanInactivityMinutes: selectedFlow.humanInactivityMinutes,
      humanGraceMinutes: selectedFlow.humanGraceMinutes,
      validityMonths: selectedFlow.validityMonths,
      pdfMaxBytes: selectedFlow.pdfMaxBytes,
      proactiveReminderDays: selectedFlow.proactiveReminderDays,
      appointmentNotificationNumbers: selectedFlow.appointmentNotificationNumbers ?? [],
      appointmentNotifications: selectedFlow.appointmentNotifications?.length
        ? selectedFlow.appointmentNotifications.map(recipient => ({
            ...recipient,
            events: [...recipient.events],
            name: recipient.name || 'Gestor',
            locationIds: [...(recipient.locationIds ?? [])],
            interviewPhases: [...(recipient.interviewPhases ?? [])],
            enabled: recipient.enabled !== false,
          }))
        : legacyNotificationRecipients(selectedFlow.appointmentNotificationNumbers),
      messages: selectedFlow.messages,
      recordMenu: completeRecordMenu(selectedFlow.recordMenu),
    };
    setMessagesJson(messages);
    setFlowKeywordsText(keywords);
    setFlowConfig(config);
    setSettingsBaseline({ flowId: selectedFlowId, snapshot: JSON.stringify([config, keywords, messages]) });
  });
  useEffect(() => {
    hydrateFlowSettings();
  }, [selectedFlow]);
  const loadAgenda = async () => {
    const isCurrent = agendaGate.current.begin();
    if (!sessionId || !selectedFlowId) {
      setSlots([]);
      setAppointments([]);
      return;
    }
    try {
      const [available, booked] = await Promise.all([
        workflowHubApi.slots(sessionId, selectedFlowId),
        workflowHubApi.appointments(sessionId, selectedFlowId),
      ]);
      if (!isCurrent()) return;
      setSlots(available);
      setAppointments(booked);
    } catch (error) {
      if (isCurrent()) toast.error(error instanceof Error ? error.message : 'Falha ao carregar a agenda');
    }
  };
  const loadCurrentAgenda = useEffectEvent(() => {
    void loadAgenda();
  });
  useEffect(() => {
    const gate = agendaGate.current;
    loadCurrentAgenda();
    return () => {
      gate.invalidate();
    };
  }, [sessionId, selectedFlowId]);
  useEffect(() => {
    setAgendaLocationFilter('all');
    setAgendaSlotSort('date-asc');
    setShowPastSlots(false);
  }, [selectedFlowId]);
  const pollCurrentTab = useEffectEvent(() => {
    if (document.visibilityState === 'hidden') return;
    if (tab === 'agenda') void loadAgenda();
    else void load({ preserveEditor: true });
  });
  useEffect(() => {
    if (!sessionId || !shouldPollWorkflowTab(tab)) return;
    const timer = window.setInterval(
      () => {
        pollCurrentTab();
      },
      tab === 'agenda' ? WORKFLOW_AGENDA_REFRESH_MS : tab === 'tickets' ? WORKFLOW_HUMAN_TICKETS_REFRESH_MS : 30_000,
    );
    return () => window.clearInterval(timer);
  }, [sessionId, selectedFlowId, tab]);
  useEffect(() => {
    if (!sessionId || !selectedFlowId || tab !== 'agenda') return;
    const refreshVisibleAgenda = () => {
      if (document.visibilityState !== 'hidden') loadCurrentAgenda();
    };
    window.addEventListener('focus', refreshVisibleAgenda);
    document.addEventListener('visibilitychange', refreshVisibleAgenda);
    return () => {
      window.removeEventListener('focus', refreshVisibleAgenda);
      document.removeEventListener('visibilitychange', refreshVisibleAgenda);
    };
  }, [sessionId, selectedFlowId, tab]);
  useEffect(() => {
    const draft =
      selectedFlow?.versions.find(version => version.status === 'RASCUNHO') ?? selectedFlow?.versions.at(-1);
    if (selectedFlowId !== draftFlowId) {
      const fields = draft?.fields ?? [];
      const graph = reconcileWorkflowGraph(draft?.definition?.graph, fields);
      setDraftFields(orderWorkflowFieldsByGraph(fields, graph));
      setDraftDefinition(draft?.definition ?? {});
      setDraftGraph(graph);
      setDraftFlowId(selectedFlowId);
      setDraftDirty(false);
      setEditorHistory({ past: [], future: [] });
      lastHistoryEdit.current = { at: 0, group: '' };
      return;
    }
    if (!draftDirty) {
      const fields = draft?.fields ?? [];
      const graph = reconcileWorkflowGraph(draft?.definition?.graph, fields);
      setDraftFields(orderWorkflowFieldsByGraph(fields, graph));
      setDraftDefinition(draft?.definition ?? {});
      setDraftGraph(graph);
    }
  }, [selectedFlowId, selectedFlow, draftFlowId, draftDirty]);
  const recordDiagramHistory = (group = 'diagram') => {
    const now = Date.now();
    const coalesced = lastHistoryEdit.current.group === group && now - lastHistoryEdit.current.at < 700;
    lastHistoryEdit.current = { at: now, group };
    setEditorHistory(current => ({
      past: coalesced ? current.past : [...current.past, { fields: draftFields, graph: visualDraftGraph }].slice(-50),
      future: [],
    }));
  };
  const undoDiagram = () => {
    const previous = editorHistory.past.at(-1);
    if (!previous) return;
    setEditorHistory(current => ({
      past: current.past.slice(0, -1),
      future: [{ fields: draftFields, graph: draftGraph }, ...current.future].slice(0, 50),
    }));
    setDraftFields(previous.fields);
    setDraftGraph(previous.graph);
    setDraftDirty(true);
    lastHistoryEdit.current = { at: 0, group: '' };
  };
  const redoDiagram = () => {
    const next = editorHistory.future[0];
    if (!next) return;
    setEditorHistory(current => ({
      past: [...current.past, { fields: draftFields, graph: draftGraph }].slice(-50),
      future: current.future.slice(1),
    }));
    setDraftFields(next.fields);
    setDraftGraph(next.graph);
    setDraftDirty(true);
    lastHistoryEdit.current = { at: 0, group: '' };
  };
  const createFlow = async () => {
    const templates = await workflowHubApi.templates(sessionId);
    const choice = window.prompt(
      `Escolha um modelo ou digite NOVO:\n${templates.map(item => `${item.key} — ${item.name}`).join('\n')}`,
      'cadastro',
    );
    if (!choice) return;
    const name = window.prompt('Nome do novo fluxo');
    if (!name) return;
    const template = templates.find(item => item.key === choice.trim().toLocaleLowerCase('pt-BR'));
    if (template) {
      await workflowHubApi.createFromTemplate(sessionId, template.key, name);
      toast.success('Fluxo criado a partir do modelo');
      await load();
      return;
    }
    await workflowHubApi.create(sessionId, {
      name,
      keywords: [name.toLocaleLowerCase('pt-BR')],
      fields: [
        { id: 'nome', label: 'Nome', prompt: 'Qual é o seu nome completo?', type: 'text', required: true, order: 1 },
        { id: 'email', label: 'E-mail', prompt: 'Qual é o seu e-mail?', type: 'email', required: true, order: 2 },
      ],
    });
    toast.success('Fluxo criado como rascunho');
    await load();
  };
  const saveFlowDraft = async (options: { reload?: boolean; notify?: boolean } = {}): Promise<boolean> => {
    if (!selectedFlow || savingDraftRef.current) return false;
    const issues = inspectWorkflowGraph(visualDraftGraph);
    if (issues.length) {
      toast.error(issues[0].message);
      setTab('diagram');
      return false;
    }
    savingDraftRef.current = true;
    setSavingDraft(true);
    const snapshot = editorSnapshot;
    try {
      const graph = visualDraftGraph;
      const saved = await workflowHubApi.saveDraft(sessionId, selectedFlow.id, draftFields, {
        ...draftDefinition,
        graph,
      });
      if (snapshot !== latestEditorSnapshot.current) {
        toast.success('Versão enviada salva. Suas alterações mais recentes continuam pendentes; salve novamente.');
        return false;
      }
      setFlows(current =>
        current.map(flow =>
          flow.id === selectedFlow.id
            ? {
                ...flow,
                versions: [
                  ...flow.versions.filter(version => version.id !== saved.id && version.status !== 'RASCUNHO'),
                  saved,
                ],
              }
            : flow,
        ),
      );
      setDraftFields(saved.fields);
      setDraftDefinition(saved.definition);
      setDraftGraph(saved.definition.graph ?? graph);
      setDraftDirty(false);
      if (options.notify !== false) toast.success('Rascunho salvo');
      if (options.reload !== false) await load();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'JSON de campos inválido');
      return false;
    } finally {
      savingDraftRef.current = false;
      setSavingDraft(false);
    }
  };
  const publishSelectedFlow = async () => {
    if (!selectedFlow) return;
    if ((draftDirty || !hasDraftVersion) && !(await saveFlowDraft({ reload: false, notify: false }))) return;
    try {
      await workflowHubApi.publish(sessionId, selectedFlow.id);
      toast.success('Alterações salvas e fluxo publicado');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao publicar o fluxo');
    }
  };
  const patchDraftField = (index: number, patch: Partial<WorkflowField>) => {
    setDraftDirty(true);
    setDraftFields(fields => fields.map((field, position) => (position === index ? { ...field, ...patch } : field)));
  };
  const patchDraftFieldLabel = (index: number, label: string) => {
    const field = draftFields[index];
    if (!field) return;
    const currentKey = field.answerKey ?? field.id;
    const fieldWasPersisted = Boolean(
      selectedFlow?.versions.some(version => version.fields.some(savedField => savedField.id === field.id)),
    );
    const followsTitle =
      !fieldWasPersisted &&
      (currentKey === normalizeAnswerKey(field.label) ||
        /^campo_\d+$/.test(currentKey) ||
        /^nova_pergunta_\d+$/.test(currentKey));
    patchDraftField(index, {
      label,
      ...(followsTitle ? { answerKey: uniqueAnswerKey(label, draftFields, field.id) } : {}),
    });
  };
  const addDraftQuestion = () => {
    const id = `etapa_${Date.now()}_${draftFields.length + 1}`;
    setDraftDirty(true);
    setExpandedFlowNodeId(`question:${id}`);
    setDraftFields(fields => [
      ...fields,
      {
        id,
        answerKey: uniqueAnswerKey(`nova_pergunta_${fields.length + 1}`, fields),
        label: 'Nova pergunta',
        prompt: 'Digite a pergunta que será enviada:',
        type: 'text',
        required: false,
        order: fields.length + 1,
      },
    ]);
  };
  const recalculateCandidateProximity = async () => {
    if (!selected || recalculatingProximity) return;
    setRecalculatingProximity(true);
    try {
      const queued = await workflowHubApi.recalculateRecordProximity(sessionId, selected.id);
      setSelected(current => (current?.id === queued.id ? { ...current, ...queued } : current));
      setCandidates(current =>
        current.map(candidate => (candidate.id === queued.id ? { ...candidate, ...queued } : candidate)),
      );
      toast.success('Cálculo de proximidade iniciado.');
      await load({ preserveEditor: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível recalcular a proximidade.');
    } finally {
      setRecalculatingProximity(false);
    }
  };
  const saveCandidateData = async () => {
    if (!selected || candidateSaving) return;
    const fields = candidateDefinitionFields(selected);
    const data = Object.fromEntries(
      fields
        .filter(field => field.type !== 'pdf' && field.type !== 'appointment')
        .filter(field => candidateFieldIsVisible(field, fields, candidateEditData))
        .filter(field => {
          const key = field.answerKey ?? field.id;
          return JSON.stringify(candidateEditData[key] ?? '') !== JSON.stringify(candidateEditBaseline[key] ?? '');
        })
        .map(field => {
          const key = field.answerKey ?? field.id;
          return [key, candidateEditData[key] ?? ''];
        }),
    );
    if (!Object.keys(data).length) {
      setCandidateEditing(false);
      toast.success('Nenhuma alteração foi necessária.');
      return;
    }
    setCandidateSaving(true);
    try {
      const updated = await workflowHubApi.updateRecord(sessionId, selected.id, data, candidateEditVersion);
      const merged = { ...selected, ...updated, instanceName: selected.instanceName };
      setSelected(merged);
      setCandidates(current => current.map(candidate => (candidate.id === merged.id ? merged : candidate)));
      setCandidateEditData(merged.data);
      setCandidateEditBaseline(merged.data);
      setCandidateEditVersion(merged.currentVersion);
      setCandidateEditing(false);
      setCandidateProfileRefreshRevision(value => value + 1);
      toast.success(
        merged.proximityStatus === 'PENDENTE' || merged.proximityStatus === 'PROCESSANDO'
          ? 'Dados atualizados. A pesquisa do novo endereço foi iniciada.'
          : 'Dados do candidato atualizados e registrados no histórico.',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível atualizar o candidato.');
    } finally {
      setCandidateSaving(false);
    }
  };
  const saveCandidateContact = async () => {
    if (!selected || !candidateContactEditingId || candidateContactSaving) return;
    const phone = candidateContactPhone.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 15) {
      toast.error('Informe DDI, DDD e número, usando de 10 a 15 dígitos.');
      return;
    }
    setCandidateContactSaving(true);
    try {
      await workflowHubApi.updateRecordContact(sessionId, selected.id, candidateContactEditingId, phone);
      setCandidateContactEditingId(null);
      setCandidateContactPhone('');
      await load({ preserveEditor: true });
      toast.success('Número vinculado atualizado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível atualizar o número vinculado.');
    } finally {
      setCandidateContactSaving(false);
    }
  };
  const makeCandidateContactPrimary = async (contactLinkId: string) => {
    if (!selected || candidateContactSaving) return;
    setCandidateContactSaving(true);
    try {
      await workflowHubApi.setPrimaryRecordContact(sessionId, selected.id, contactLinkId);
      await load({ preserveEditor: true });
      toast.success('Número principal atualizado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível alterar o número principal.');
    } finally {
      setCandidateContactSaving(false);
    }
  };
  const deleteCandidateContact = async () => {
    if (!selected || !candidateContactPendingDelete || candidateContactSaving) return;
    setCandidateContactSaving(true);
    try {
      await workflowHubApi.deleteRecordContact(sessionId, selected.id, candidateContactPendingDelete.id);
      setCandidateContactPendingDelete(null);
      await load({ preserveEditor: true });
      toast.success('Número desvinculado do usuário.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível excluir o número vinculado.');
    } finally {
      setCandidateContactSaving(false);
    }
  };
  const addDraftMessage = () => {
    const review = visualDraftGraph.nodes.find(node => node.type === 'review');
    const incoming = review ? visualDraftGraph.edges.filter(edge => edge.target === review.id) : [];
    if (!review || !incoming.length) return;
    const sources = incoming
      .map(edge => visualDraftGraph.nodes.find(node => node.id === edge.source))
      .filter(node => node !== undefined);
    const id = `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const edgeSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    recordDiagramHistory('message-add');
    setDraftGraph({
      ...visualDraftGraph,
      nodes: [
        ...visualDraftGraph.nodes,
        {
          id,
          type: 'message',
          position: {
            x: sources.length
              ? (Math.max(...sources.map(source => source.position.x)) + review.position.x) / 2
              : review.position.x - 220,
            y: sources.length
              ? sources.reduce((total, source) => total + source.position.y, 0) / sources.length
              : review.position.y,
          },
          data: { label: 'Nova mensagem', text: 'Digite aqui a mensagem que será enviada.' },
        },
      ],
      edges: [
        ...visualDraftGraph.edges.filter(item => !incoming.some(edge => edge.id === item.id)),
        ...incoming.map((edge, index) => ({ ...edge, id: `edge_before_${edgeSuffix}_${index}`, target: id })),
        { id: `edge_after_${edgeSuffix}`, source: id, target: review.id },
      ],
    });
    setExpandedFlowNodeId(id);
    setDraftDirty(true);
  };
  const moveDraftFlowNodeTo = (nodeId: string, targetNodeId: string) => {
    if (nodeId === targetNodeId) return;
    const graph = moveLinearWorkflowNodeTo(visualDraftGraph, nodeId, targetNodeId);
    if (!graph) {
      toast.error('Este fluxo possui ramificações. Reorganize os blocos pelas ligações no Diagrama.');
      return;
    }
    const orderedFields = orderWorkflowFieldsByGraph(draftFields, graph);
    const invalid = orderedFields.find((field, index) => {
      if (!field.visibleWhen) return false;
      return orderedFields.findIndex(item => item.id === field.visibleWhen?.fieldId) >= index;
    });
    if (invalid) {
      toast.error(`“${invalid.label}” precisa ficar depois da pergunta da qual depende.`);
      return;
    }
    recordDiagramHistory('node-drag');
    setDraftGraph(graph);
    setDraftFields(orderedFields);
    setDraftDirty(true);
  };
  const moveDraftFlowNode = (nodeId: string, offset: -1 | 1) => {
    const index = editableFlowNodes.findIndex(node => node.id === nodeId);
    const target = editableFlowNodes[index + offset];
    if (index < 0 || !target) return;
    moveDraftFlowNodeTo(nodeId, target.id);
  };
  const beginFlowCardPointer = (event: ReactPointerEvent<HTMLElement>, nodeId: string) => {
    if (!isAdmin || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const card = event.currentTarget.closest<HTMLElement>('.question-card');
    const rect = card?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const node = editableFlowNodes.find(item => item.id === nodeId);
    const field = node?.type === 'question' ? draftFields.find(item => item.id === node.data.fieldId) : null;
    flowPointerDrag.current = {
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      title: node?.type === 'message' ? node.data.label || 'Mensagem sem título' : field?.label || 'Pergunta',
      subtitle:
        node?.type === 'message'
          ? 'Mensagem inserida entre as perguntas do fluxo'
          : `${field?.type ?? 'campo'} · ${field?.required ? 'Obrigatória' : 'Opcional'}`,
      moved: false,
    };
    dragOverFlowNodeIdRef.current = null;
    setDragOverFlowNodeId(null);
  };
  const enterFlowCardPointerTarget = (nodeId: string) => {
    const drag = flowPointerDrag.current;
    if (!drag?.moved || drag.nodeId === nodeId || dragOverFlowNodeIdRef.current === nodeId) return;
    dragOverFlowNodeIdRef.current = nodeId;
    setDragOverFlowNodeId(nodeId);
  };
  const finishFlowCardPointer = (targetNodeId: string) => {
    const drag = flowPointerDrag.current;
    const shouldMove =
      Boolean(drag?.moved) && drag?.nodeId !== targetNodeId && editableFlowNodes.some(node => node.id === drag?.nodeId);
    if (drag?.moved) suppressFlowCardClickUntil.current = Date.now() + 500;
    const sourceNodeId = drag?.nodeId;
    clearFlowDrag();
    if (shouldMove && sourceNodeId) window.setTimeout(() => moveDraftFlowNodeTo(sourceNodeId, targetNodeId), 0);
  };
  const removeDraftMessage = (nodeId: string) => {
    const graph = removeWorkflowMessageNode(visualDraftGraph, nodeId);
    if (!graph) return;
    recordDiagramHistory('message-remove');
    setDraftGraph(graph);
    setExpandedFlowNodeId(current => (current === nodeId ? null : current));
    setDraftDirty(true);
  };
  const setFieldOptions = (fieldIndex: number, options: string[]) => {
    const talentPoolOption = draftFields[fieldIndex]?.talentPoolOption;
    patchDraftField(fieldIndex, {
      options,
      ...(talentPoolOption && !options.includes(talentPoolOption) ? { talentPoolOption: undefined } : {}),
    });
  };
  const patchFieldOption = (fieldIndex: number, optionIndex: number, value: string) => {
    const field = draftFields[fieldIndex];
    const options = [...(field.options ?? [])];
    const previousValue = options[optionIndex];
    options[optionIndex] = value;
    patchDraftField(fieldIndex, {
      options,
      ...(field.talentPoolOption === previousValue ? { talentPoolOption: value } : {}),
    });
  };
  const addFieldOption = (fieldIndex: number) =>
    setFieldOptions(fieldIndex, [...(draftFields[fieldIndex].options ?? []), '']);
  const removeFieldOption = (fieldIndex: number, optionIndex: number) =>
    setFieldOptions(
      fieldIndex,
      (draftFields[fieldIndex].options ?? []).filter((_, index) => index !== optionIndex),
    );
  const selectFlow = (id: string) => {
    if (id === selectedFlowId) return;
    if (draftDirty || settingsDirty) {
      setPendingEditorNavigation({ type: 'flow', id });
      return;
    }
    setSelectedFlowId(id);
    setExpandedFlowNodeId(null);
  };
  const selectAgendaLocation = (location: AgendaLocation | undefined) => {
    setSlotLocationId(location?.id ?? '');
    setSlotLocation(location?.name ?? '');
    setSlotAddress(location?.address ?? '');
    setSlotMapsUrl(location?.mapsUrl ?? '');
  };
  const clearAgendaLocationEditor = () => {
    setLocationEditorOpen(false);
    setEditingLocationId(null);
    setNewLocationInternalName('');
    setNewLocationName('');
    setNewLocationAddress('');
    setNewLocationMapsUrl('');
    setNewLocationLatitude('');
    setNewLocationLongitude('');
    setNewLocationContacts([]);
  };
  const editAgendaLocation = (location: AgendaLocation) => {
    setLocationEditorOpen(true);
    setEditingLocationId(location.id);
    setNewLocationInternalName(location.internalName || location.name);
    setNewLocationName(location.name);
    setNewLocationAddress(location.address ?? '');
    setNewLocationMapsUrl(location.mapsUrl ?? '');
    setNewLocationLatitude(location.latitude === undefined ? '' : String(location.latitude));
    setNewLocationLongitude(location.longitude === undefined ? '' : String(location.longitude));
    setNewLocationContacts(
      (location.notificationContacts ?? []).map(contact => ({
        ...contact,
        enabled: contact.enabled !== false,
      })),
    );
  };
  const toggleAgendaLocationEditor = (location: AgendaLocation) => {
    if (nextAgendaLocationEditorId(locationEditorOpen, editingLocationId, location.id) === null) {
      clearAgendaLocationEditor();
      return;
    }
    editAgendaLocation(location);
  };
  const openNewAgendaLocationEditor = () => {
    clearAgendaLocationEditor();
    setLocationEditorOpen(true);
  };
  const updateNewLocationContact = (id: string, patch: Partial<LocationContactDraft>) =>
    setNewLocationContacts(current => current.map(contact => (contact.id === id ? { ...contact, ...patch } : contact)));
  const saveAgendaLocation = async () => {
    if (!department || !newLocationInternalName.trim() || !newLocationName.trim()) return;
    if (
      agendaLocations.some(
        location =>
          location.id !== editingLocationId &&
          (location.internalName || location.name).toLocaleLowerCase('pt-BR') ===
            newLocationInternalName.trim().toLocaleLowerCase('pt-BR'),
      )
    ) {
      toast.error('Já existe um local com esse nome interno neste setor.');
      return;
    }
    const mapsUrl = newLocationMapsUrl.trim();
    if (mapsUrl) {
      try {
        const parsed = new URL(mapsUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        toast.error('Informe um link válido do Google Maps, começando com http:// ou https://.');
        return;
      }
    }
    const latitude = Number(newLocationLatitude);
    const longitude = Number(newLocationLongitude);
    if (
      !newLocationAddress.trim() ||
      !newLocationLatitude.trim() ||
      !newLocationLongitude.trim() ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      toast.error('Informe o endereço, a latitude e a longitude válidas do local.');
      return;
    }
    const locationId = editingLocationId ?? `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const notificationContacts: NonNullable<AgendaLocation['notificationContacts']> = [];
    for (const [index, contact] of newLocationContacts.entries()) {
      const ddi = contact.ddi.replace(/\D/g, '');
      const ddd = contact.ddd.replace(/\D/g, '');
      const number = contact.number.replace(/\D/g, '');
      const started = Boolean(contact.role.trim() || contact.name.trim() || ddd || number);
      if (!started) continue;
      if (
        !contact.role.trim() ||
        !contact.name.trim() ||
        !/^\d{1,3}$/.test(ddi) ||
        !/^\d{2,3}$/.test(ddd) ||
        !/^\d{6,10}$/.test(number)
      ) {
        toast.error(`Preencha função, responsável, DDI, DDD e número válidos no contato ${index + 1}.`);
        return;
      }
      notificationContacts.push({
        id: contact.id,
        role: contact.role.trim(),
        name: contact.name.trim(),
        ddi,
        ddd,
        number,
        enabled: contact.enabled,
      });
    }
    if (
      new Set(notificationContacts.map(contact => `${contact.ddi}${contact.ddd}${contact.number}`)).size !==
      notificationContacts.length
    ) {
      toast.error('Os responsáveis do local precisam ter telefones diferentes.');
      return;
    }
    const location: AgendaLocation = {
      id: locationId,
      internalName: newLocationInternalName.trim(),
      name: newLocationName.trim(),
      address: newLocationAddress.trim(),
      ...(mapsUrl ? { mapsUrl } : {}),
      latitude,
      longitude,
      notificationContacts,
    };
    try {
      const wasClean = !departmentDirty;
      const locations = editingLocationId
        ? agendaLocations.map(current => (current.id === editingLocationId ? location : current))
        : [...agendaLocations, location];
      const saved = await workflowHubApi.updateDepartment(sessionId, {
        schedule: { ...department.schedule, locations },
      });
      const nextDepartment = { ...department, schedule: saved.schedule };
      const savedSchedule = JSON.stringify(saved.schedule ?? {}, null, 2);
      setDepartment(nextDepartment);
      setScheduleJson(savedSchedule);
      if (wasClean) {
        departmentBaseline.current = JSON.stringify([nextDepartment, savedSchedule]);
        setSavedDepartmentSnapshot(departmentBaseline.current);
      }
      if (slotLocationId === location.id || !editingLocationId) selectAgendaLocation(location);
      clearAgendaLocationEditor();
      toast.success(editingLocationId ? 'Local atualizado' : 'Local adicionado à agenda');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o local.');
    }
  };
  const renderAgendaLocationEditor = (id?: string) => (
    <div className="agenda-location-editor-card" id={id}>
      <div className="agenda-location-editor-heading">
        <div>
          <strong>{editingLocationId ? 'Editar local' : 'Cadastrar novo local'}</strong>
          <small>Dados do endereço e pessoas que recebem os avisos deste local.</small>
        </div>
        <button className="btn-secondary" type="button" onClick={clearAgendaLocationEditor}>
          Fechar
        </button>
      </div>
      <div className="agenda-location-fields">
        <label>
          Nome para o setor
          <input
            maxLength={160}
            value={newLocationInternalName}
            onChange={event => setNewLocationInternalName(event.target.value)}
            placeholder="Ex.: Matriz — Floresta"
          />
        </label>
        <label>
          Nome do local para o cliente
          <input
            maxLength={160}
            value={newLocationName}
            onChange={event => setNewLocationName(event.target.value)}
            placeholder="Ex.: Ambrozini Floresta"
          />
        </label>
        <label>
          Endereço por escrito
          <input
            maxLength={500}
            value={newLocationAddress}
            onChange={event => setNewLocationAddress(event.target.value)}
            placeholder="Ex.: Rua X, 100 — Floresta, Belo Horizonte"
          />
        </label>
        <label>
          Link do Google Maps
          <input
            type="url"
            maxLength={1000}
            value={newLocationMapsUrl}
            onChange={event => setNewLocationMapsUrl(event.target.value)}
            placeholder="https://maps.app.goo.gl/..."
          />
        </label>
        <label>
          Latitude
          <input
            type="number"
            step="any"
            min="-90"
            max="90"
            value={newLocationLatitude}
            onChange={event => setNewLocationLatitude(event.target.value)}
            placeholder="Ex.: -19.9167"
          />
        </label>
        <label>
          Longitude
          <input
            type="number"
            step="any"
            min="-180"
            max="180"
            value={newLocationLongitude}
            onChange={event => setNewLocationLongitude(event.target.value)}
            placeholder="Ex.: -43.9345"
          />
        </label>
        <div className="agenda-location-contact-heading">
          <div>
            <strong>Responsáveis avisados</strong>
            <small>Cadastre livremente RH, DP, gerente, subgerente ou outra função.</small>
          </div>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => setNewLocationContacts(current => [...current, newLocationContact()])}
          >
            <Plus size={15} /> Adicionar responsável
          </button>
        </div>
        {newLocationContacts.length === 0 && (
          <div className="agenda-location-contact-empty">Nenhum responsável vinculado a este local.</div>
        )}
        {newLocationContacts.map((contact, index) => (
          <fieldset className="agenda-location-contact" key={contact.id}>
            <legend>Responsável {index + 1}</legend>
            <label>
              Função
              <input
                aria-label={`Função do responsável ${index + 1}`}
                maxLength={80}
                value={contact.role}
                onChange={event => updateNewLocationContact(contact.id, { role: event.target.value })}
                placeholder="Ex.: RH, DP ou Gerente"
              />
            </label>
            <label className="agenda-contact-name">
              Responsável
              <input
                aria-label={`Nome do responsável ${index + 1}`}
                maxLength={120}
                value={contact.name}
                onChange={event => updateNewLocationContact(contact.id, { name: event.target.value })}
                placeholder="Nome da pessoa"
              />
            </label>
            <label>
              DDI
              <input
                aria-label={`DDI do responsável ${index + 1}`}
                inputMode="numeric"
                maxLength={3}
                value={contact.ddi}
                onChange={event => updateNewLocationContact(contact.id, { ddi: event.target.value.replace(/\D/g, '') })}
                placeholder="55"
              />
            </label>
            <label>
              DDD
              <input
                aria-label={`DDD do responsável ${index + 1}`}
                inputMode="numeric"
                maxLength={3}
                value={contact.ddd}
                onChange={event => updateNewLocationContact(contact.id, { ddd: event.target.value.replace(/\D/g, '') })}
                placeholder="31"
              />
            </label>
            <label className="agenda-contact-number">
              Número
              <input
                aria-label={`Número do responsável ${index + 1}`}
                inputMode="numeric"
                maxLength={10}
                value={contact.number}
                onChange={event =>
                  updateNewLocationContact(contact.id, { number: event.target.value.replace(/\D/g, '') })
                }
                placeholder="999999999"
              />
            </label>
            <button
              className="icon-danger agenda-location-contact-remove"
              type="button"
              aria-label={`Remover responsável ${index + 1}`}
              title="Remover responsável"
              onClick={() =>
                setNewLocationContacts(current => current.filter(currentContact => currentContact.id !== contact.id))
              }
            >
              <Trash2 size={16} />
            </button>
            <small>Receberá marcações, cancelamentos, reagendamentos e conclusões deste local.</small>
          </fieldset>
        ))}
        <div className="agenda-location-editor-actions">
          <button
            className="btn-primary"
            type="button"
            disabled={
              !newLocationInternalName.trim() ||
              !newLocationName.trim() ||
              !newLocationAddress.trim() ||
              !newLocationLatitude.trim() ||
              !newLocationLongitude.trim()
            }
            onClick={() => void saveAgendaLocation()}
          >
            <Save size={16} /> {editingLocationId ? 'Salvar alterações' : 'Salvar local'}
          </button>
          <button className="btn-secondary" type="button" onClick={clearAgendaLocationEditor}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
  const addSlot = async () => {
    if (!selectedFlow || !slotDate || creatingSlot) return;
    if (new Date(slotDate) <= new Date()) {
      toast.error('Escolha uma data e um horário futuros.');
      return;
    }
    setCreatingSlot(true);
    try {
      await workflowHubApi.createSlots(sessionId, selectedFlow.id, [
        {
          startsAt: new Date(slotDate).toISOString(),
          capacity: slotCapacity,
          locationId: slotLocationId || undefined,
          location: slotLocation.trim() || undefined,
          address: slotAddress || undefined,
          instruction: slotInstruction.trim() || undefined,
          responsible: slotResponsible.trim() || undefined,
          mapsUrl: slotMapsUrl.trim() || undefined,
          interviewPhase: slotInterviewPhase,
        },
      ]);
      setSlotDate('');
      toast.success('Horário disponibilizado');
      await Promise.all([load(), loadAgenda()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível disponibilizar o horário.');
    } finally {
      setCreatingSlot(false);
    }
  };
  const openSlotEdit = (slot: WorkflowSlot) => {
    setSlotPendingEdit(slot);
    setEditSlotInstruction(slot.instruction ?? '');
    setEditSlotResponsible(slot.responsible ?? '');
    setEditSlotInterviewPhase(slot.interviewPhase ?? 'FASE_1_ENTREVISTA_SIMPLES');
    setEditSlotCapacity(slot.capacity);
  };
  const requestSlotRemoval = (slot: WorkflowSlot) => {
    const confirmedCount = appointments.filter(
      appointment => appointment.status === 'CONFIRMADO' && appointment.slot?.id === slot.id,
    ).length;
    const occupiedSlot = { ...slot, bookedCount: Math.max(slot.bookedCount, confirmedCount) };
    if (occupiedSlot.bookedCount <= 0) {
      setSlotPendingDelete(slot);
      return;
    }
    setRescheduleDate('');
    setRescheduleLocationId(
      slot.locationId ??
        agendaLocations.find(
          location => location.name === slot.location && (location.address ?? '') === (slot.address ?? ''),
        )?.id ??
        '',
    );
    setRescheduleLocation(slot.location ?? '');
    setRescheduleAddress(slot.address ?? '');
    setRescheduleInstruction(slot.instruction ?? '');
    setRescheduleResponsible(slot.responsible ?? '');
    setRescheduleInterviewPhase(slot.interviewPhase ?? 'FASE_1_ENTREVISTA_SIMPLES');
    setRescheduleMapsUrl(slot.mapsUrl ?? '');
    setRescheduleCapacity(Math.max(slot.capacity, occupiedSlot.bookedCount));
    setSlotPendingReschedule(occupiedSlot);
  };

  const isSettingsCardExpanded = (cardId: SettingsCardId) => expandedSettingsCards.includes(cardId);
  const toggleSettingsCard = (cardId: SettingsCardId) => {
    setExpandedSettingsCards(current =>
      current.includes(cardId) ? current.filter(item => item !== cardId) : [...current, cardId],
    );
  };
  const settingsCardHeaderProps = (cardId: SettingsCardId) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': isSettingsCardExpanded(cardId),
    'aria-controls': `settings-panel-${cardId}`,
    onClick: () => toggleSettingsCard(cardId),
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleSettingsCard(cardId);
    },
  });
  const settingsCardChevron = (cardId: SettingsCardId) => {
    const expanded = isSettingsCardExpanded(cardId);
    return (
      <span className="settings-panel-toggle" aria-hidden="true">
        {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      </span>
    );
  };
  const toggleAutomaticMessageGroup = (groupId: AutomaticMessageGroupId) => {
    setExpandedAutomaticMessageGroups(current =>
      current.includes(groupId) ? current.filter(item => item !== groupId) : [...current, groupId],
    );
  };

  const confirmHumanServiceChange = async () => {
    if (humanServiceTargetEnabled === null || humanServiceSaving) return;
    setHumanServiceSaving(true);
    try {
      const result = await workflowHubApi.setHumanServiceEnabled(sessionId, humanServiceTargetEnabled);
      setDepartment(current =>
        current ? { ...current, humanServiceEnabled: result.department.humanServiceEnabled } : result.department,
      );
      if (departmentBaseline.current) {
        const [baselineDepartment, baselineSchedule] = JSON.parse(departmentBaseline.current) as [
          WorkflowDepartment,
          string,
        ];
        departmentBaseline.current = JSON.stringify([
          { ...baselineDepartment, humanServiceEnabled: result.department.humanServiceEnabled },
          baselineSchedule,
        ]);
        setSavedDepartmentSnapshot(departmentBaseline.current);
      }
      setHumanServiceTargetEnabled(null);
      await load({ preserveEditor: true });
      if (result.department.humanServiceEnabled) toast.success('Atendimento humano reativado.');
      else toast.success('Novos atendimentos bloqueados. Os chamados abertos continuam ativos.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível alterar o atendimento humano.');
    } finally {
      setHumanServiceSaving(false);
    }
  };

  const confirmRuntimeStatusChange = async () => {
    if (!runtimePendingAction || runtimeActionSaving || !selectedSession) return;
    setRuntimeActionSaving(true);
    try {
      if (runtimePendingAction === 'plugin') {
        if (!isAdmin || !runtimeStatus) return;
        if (runtimeStatus.status === 'enabled') {
          await pluginsApi.disable(runtimeStatus.pluginId);
          toast.success('Plugin da Central de Recrutamento desativado.');
        } else {
          await pluginsApi.enable(runtimeStatus.pluginId);
          toast.success('Plugin da Central de Recrutamento ativado.');
        }
      } else if (sessionActive) {
        await sessionApi.stop(selectedSession.id);
        toast.success('Sessão do WhatsApp desativada.');
      } else {
        await sessionApi.start(selectedSession.id);
        toast.success('Inicialização da sessão do WhatsApp solicitada.');
      }
      setRuntimePendingAction(null);
      await refetchSessions();
      await load({ preserveEditor: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível alterar o status.');
    } finally {
      setRuntimeActionSaving(false);
    }
  };

  return (
    <div className="talent-page">
      <PageHeader
        title="Central de Recrutamento"
        subtitle="Formulários, cadastros, agenda e atendimento humano pelo WhatsApp"
        actions={
          <div className="talent-actions">
            <div className="talent-runtime-status" aria-label="Status da Central de Recrutamento">
              <button
                type="button"
                className={
                  runtimeStatus ? (runtimeStatus.activeForSession ? 'is-active' : 'is-inactive') : 'is-pending'
                }
                disabled={!isAdmin || !runtimeStatus || runtimeActionSaving}
                onClick={() => setRuntimePendingAction('plugin')}
                title={isAdmin ? 'Clique para ativar ou desativar o plugin' : 'Somente administradores alteram o plugin'}
              >
                Plugin {runtimeStatus ? (runtimeStatus.activeForSession ? 'ativo' : 'desativado') : 'verificando…'}
              </button>
              <button
                type="button"
                className={selectedSession ? (sessionActive ? 'is-active' : 'is-inactive') : 'is-pending'}
                disabled={!canWrite || !selectedSession || runtimeActionSaving}
                onClick={() => setRuntimePendingAction('session')}
                title={canWrite ? 'Clique para iniciar ou parar a sessão' : 'Seu perfil não pode alterar a sessão'}
              >
                Sessão {selectedSession ? (sessionActive ? 'ativa' : 'inativa') : 'verificando…'}
              </button>
            </div>
            <select
              value={sessionId}
              onChange={event => {
                if (draftDirty || settingsDirty || departmentDirty)
                  setPendingEditorNavigation({ type: 'session', id: event.target.value });
                else setSessionId(event.target.value);
              }}
              aria-label="Número e setor do WhatsApp"
            >
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
            </select>
            <button className="btn-secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={16} /> Atualizar
            </button>
          </div>
        }
      />
      <div className="talent-summary">
        <div>
          <GitBranch size={22} />
          <span>
            <strong>{indicators?.published ?? 0}</strong> fluxos publicados
          </span>
        </div>
        <div>
          <Users size={22} />
          <span>
            <strong>{activeCandidates.length}</strong> candidatos
          </span>
        </div>
        <div>
          <BriefcaseBusiness size={22} />
          <span>
            <strong>{activeTickets.length}</strong> chamados abertos
          </span>
        </div>
        <div className={runtimeStatus?.activeForSession ? 'enabled' : 'disabled'}>
          Central de Recrutamento {runtimeStatus?.activeForSession ? 'ativa' : 'desativada'}
        </div>
      </div>
      <div className="talent-tabs">
        {isAdmin && (
          <button className={tab === 'flows' ? 'active' : ''} onClick={() => setTab('flows')}>
            Fluxos
          </button>
        )}
        {isAdmin && (
          <button className={tab === 'diagram' ? 'active' : ''} onClick={() => setTab('diagram')}>
            Diagrama
          </button>
        )}
        <button className={tab === 'agenda' ? 'active' : ''} onClick={() => setTab('agenda')}>
          Agenda
        </button>
        <button className={tab === 'recruitment' ? 'active' : ''} onClick={() => setTab('recruitment')}>
          Processo seletivo
        </button>
        <button
          className={tab === 'candidates' ? 'active' : ''}
          onClick={() => {
            setTab('candidates');
            void load({ preserveEditor: true });
          }}
        >
          Candidatos
        </button>
        <button className={tab === 'talent-bank' ? 'active' : ''} onClick={() => setTab('talent-bank')}>
          Banco de Talentos
          {talentPoolRecordIds.size > 0 && <span className="tab-alert-count">{talentPoolRecordIds.size}</span>}
        </button>
        <button className={tab === 'tickets' ? 'active' : ''} onClick={() => setTab('tickets')}>
          Atendimento humano
          {humanTicketNotifications.some(notification => !notification.read) && (
            <span className="tab-alert-count">
              {humanTicketNotifications.filter(notification => !notification.read).length}
            </span>
          )}
        </button>
        {(isAdmin || role === 'operator') && (
          <button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}>
            Envios
            {outboxHealth?.counts && outboxHealth.counts.FALHA > 0 && (
              <span className="tab-alert-count">{outboxHealth.counts.FALHA}</span>
            )}
          </button>
        )}
        {isAdmin && (
          <button className={tab === 'privacy' ? 'active' : ''} onClick={() => setTab('privacy')}>
            Privacidade
          </button>
        )}
        {isAdmin && (
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Configurações
          </button>
        )}
        {canManageHumanService(role) && department && (
          <button
            type="button"
            className="human-service-toggle"
            data-enabled={department.humanServiceEnabled !== false}
            onClick={() => setHumanServiceTargetEnabled(department.humanServiceEnabled === false)}
          >
            {department.humanServiceEnabled === false ? <Power size={16} /> : <PowerOff size={16} />}
            {department.humanServiceEnabled === false ? 'Ativar atendimento humano' : 'Encerrar atendimento humano'}
          </button>
        )}
      </div>

      {flowDragPreview && (
        <div
          className="workflow-drag-preview"
          style={{ left: flowDragPreview.x, top: flowDragPreview.y, width: flowDragPreview.width }}
          aria-hidden="true"
        >
          <span className="question-number">
            {editableFlowNodes.find(node => node.id === flowDragPreview.nodeId)?.type === 'message' ? (
              <MessageSquareText size={16} />
            ) : (
              <span>↕</span>
            )}
          </span>
          <span>
            <strong>{flowDragPreview.title}</strong>
            <small>{flowDragPreview.subtitle}</small>
          </span>
        </div>
      )}

      {tab === 'flows' && (
        <div className="flow-workspace">
          <aside className="flow-sidebar">
            <div className="flow-sidebar-header">
              <div>
                <span className="section-eyebrow">Organização</span>
                <h2>Fluxos do setor</h2>
                <small>
                  {flows.length} {flows.length === 1 ? 'fluxo criado' : 'fluxos criados'}
                </small>
              </div>
              {isAdmin && (
                <button className="btn-primary flow-new-button" onClick={() => void createFlow()}>
                  <Plus size={16} /> <span>Novo fluxo</span>
                </button>
              )}
            </div>
            <div className="flow-list">
              {flows.map(flow => (
                <button
                  key={flow.id}
                  className={`flow-list-item ${selectedFlowId === flow.id ? 'selected' : ''}`}
                  onClick={() => selectFlow(flow.id)}
                >
                  <span className="flow-list-item-topline">
                    <strong>{flow.name}</strong>
                    <ChevronRight size={17} />
                  </span>
                  <span className="flow-keywords">{flow.keywords.join(', ') || 'Sem palavra-chave'}</span>
                  <span className={`flow-status status-${flow.status.toLowerCase()}`}>{flow.status}</span>
                </button>
              ))}
              {!flows.length && (
                <div className="flow-empty-state">
                  <p>Crie o primeiro fluxo deste setor ou incorpore o Banco de Talentos atual.</p>
                  {isAdmin && (
                    <button
                      className="btn-secondary"
                      onClick={async () => {
                        await workflowHubApi.importLegacy(sessionId);
                        toast.success('Banco de Talentos incorporado à Central de Recrutamento');
                        await load();
                      }}
                    >
                      Importar projeto atual
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>
          <main className="flow-editor">
            {selectedFlow ? (
              <>
                <header className="flow-editor-header">
                  <div>
                    <span className="section-eyebrow">Editor de fluxo</span>
                    <div className="flow-title-line">
                      <h2>{selectedFlow.name}</h2>
                      <span className={`flow-status status-${selectedFlow.status.toLowerCase()}`}>
                        {selectedFlow.status}
                      </span>
                    </div>
                    <p>
                      {draftFields.length}{' '}
                      {draftFields.length === 1 ? 'pergunta configurada' : 'perguntas configuradas'}
                      {selectedFlow.keywords.length > 0 && ` · Palavra-chave: ${selectedFlow.keywords.join(', ')}`}
                    </p>
                  </div>
                  {draftDirty && <span className="unsaved-badge">Alterações não salvas</span>}
                </header>
                <section className="flow-conversation-settings">
                  <div>
                    <span className="section-eyebrow">Identidade da conversa</span>
                    <strong>Como o fluxo aparece no WhatsApp</strong>
                  </div>
                  <label>
                    <span>Nome do fluxo</span>
                    <input
                      disabled={!isAdmin}
                      value={String(flowConfig.name ?? '')}
                      onChange={event => setFlowConfig({ ...flowConfig, name: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Palavras-chave</span>
                    <input
                      disabled={!isAdmin}
                      value={flowKeywordsText}
                      placeholder="Separe por vírgulas"
                      onChange={event => {
                        setFlowKeywordsText(event.target.value);
                        setFlowConfig({
                          ...flowConfig,
                          keywords: event.target.value
                            .split(',')
                            .map(value => value.trim())
                            .filter(Boolean),
                        });
                      }}
                    />
                  </label>
                  <section className="flow-notification-recipients" aria-labelledby="notification-recipients-title">
                    <div className="flow-notification-heading">
                      <div>
                        <strong id="notification-recipients-title">Avisos de entrevistas</strong>
                        <small>Cadastre gestores e escolha os locais, fases e eventos que cada um deve receber.</small>
                      </div>
                      {isAdmin && (
                        <button
                          className="btn-secondary flow-add-recipient"
                          type="button"
                          onClick={() =>
                            setFlowConfig(current => ({
                              ...current,
                              appointmentNotifications: [
                                ...(current.appointmentNotifications ?? []),
                                {
                                  id: globalThis.crypto?.randomUUID?.() ?? `notification-${Date.now()}`,
                                  name: '',
                                  ddi: '55',
                                  ddd: '',
                                  number: '',
                                  events: ['CONFIRMADA'],
                                  locationIds: [],
                                  interviewPhases: ['FASE_2_ENTREVISTA_FOCADA', 'FASE_3_CONTRATACAO'],
                                  enabled: true,
                                },
                              ],
                            }))
                          }
                        >
                          <Plus size={15} /> Adicionar gestor
                        </button>
                      )}
                    </div>
                    {(flowConfig.appointmentNotifications ?? []).length ? (
                      <div className="flow-notification-list">
                        {(flowConfig.appointmentNotifications ?? []).map((recipient, recipientIndex) => {
                          const updateRecipient = (patch: Partial<AppointmentNotification>) =>
                            setFlowConfig(current => ({
                              ...current,
                              appointmentNotifications: (current.appointmentNotifications ?? []).map(item =>
                                item.id === recipient.id ? { ...item, ...patch } : item,
                              ),
                            }));
                          return (
                            <details className="flow-notification-row" key={recipient.id}>
                              <summary
                                className="flow-notification-card-header"
                                aria-label={`Expandir configurações de gestor ${recipientIndex + 1}`}
                              >
                                <strong>{recipient.name.trim() || 'Novo gestor'}</strong>
                                <ChevronDown size={18} aria-hidden="true" />
                              </summary>
                              <div className="flow-notification-card-content">
                                <div className="flow-notification-manager">
                                  <label className="flow-manager-name">
                                    <span>Nome do gestor</span>
                                    <input
                                      aria-label={`Nome do gestor ${recipientIndex + 1}`}
                                      disabled={!isAdmin}
                                      maxLength={120}
                                      placeholder="Ex.: Amanda — Floresta"
                                      value={recipient.name}
                                      onChange={event => updateRecipient({ name: event.target.value })}
                                    />
                                  </label>
                                  <label className="flow-manager-enabled">
                                    <input
                                      checked={recipient.enabled !== false}
                                      disabled={!isAdmin}
                                      type="checkbox"
                                      onChange={event => updateRecipient({ enabled: event.target.checked })}
                                    />
                                    Receber avisos
                                  </label>
                                  {isAdmin && (
                                    <button
                                      className="icon-button danger"
                                      type="button"
                                      aria-label={`Remover gestor ${recipientIndex + 1}`}
                                      title="Remover gestor"
                                      onClick={() =>
                                        setFlowConfig(current => ({
                                          ...current,
                                          appointmentNotifications: (current.appointmentNotifications ?? []).filter(
                                            item => item.id !== recipient.id,
                                          ),
                                        }))
                                      }
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  )}
                                </div>
                                <div className="flow-phone-fields">
                                  <label>
                                    <span>DDI</span>
                                    <input
                                      aria-label={`DDI do destinatário ${recipientIndex + 1}`}
                                      disabled={!isAdmin}
                                      inputMode="numeric"
                                      maxLength={3}
                                      placeholder="55"
                                      value={recipient.ddi}
                                      onChange={event =>
                                        updateRecipient({ ddi: event.target.value.replace(/\D/g, '') })
                                      }
                                    />
                                  </label>
                                  <label>
                                    <span>DDD</span>
                                    <input
                                      aria-label={`DDD do destinatário ${recipientIndex + 1}`}
                                      disabled={!isAdmin}
                                      inputMode="numeric"
                                      maxLength={3}
                                      placeholder="31"
                                      value={recipient.ddd}
                                      onChange={event =>
                                        updateRecipient({ ddd: event.target.value.replace(/\D/g, '') })
                                      }
                                    />
                                  </label>
                                  <label className="flow-phone-number">
                                    <span>Número</span>
                                    <input
                                      aria-label={`Número do destinatário ${recipientIndex + 1}`}
                                      disabled={!isAdmin}
                                      inputMode="numeric"
                                      maxLength={10}
                                      placeholder="999999999"
                                      value={recipient.number}
                                      onChange={event =>
                                        updateRecipient({ number: event.target.value.replace(/\D/g, '') })
                                      }
                                    />
                                  </label>
                                </div>
                                <div className="flow-notification-scope">
                                  <strong>Locais avisados</strong>
                                  <div className="flow-notification-events">
                                    <button
                                      className={`flow-event-chip ${!(recipient.locationIds ?? []).length ? 'is-selected' : ''}`}
                                      disabled={!isAdmin}
                                      type="button"
                                      onClick={() => updateRecipient({ locationIds: [] })}
                                    >
                                      Todos os locais
                                    </button>
                                    {agendaLocations.map(location => {
                                      const selected = (recipient.locationIds ?? []).includes(location.id);
                                      return (
                                        <button
                                          className={`flow-event-chip ${selected ? 'is-selected' : ''}`}
                                          disabled={!isAdmin}
                                          key={location.id}
                                          type="button"
                                          onClick={() =>
                                            updateRecipient({
                                              locationIds: selected
                                                ? recipient.locationIds.filter(id => id !== location.id)
                                                : [...(recipient.locationIds ?? []), location.id],
                                            })
                                          }
                                        >
                                          {location.name}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                                <div className="flow-notification-scope">
                                  <strong>Fases avisadas</strong>
                                  <div className="flow-notification-events">
                                    <button
                                      className={`flow-event-chip ${!(recipient.interviewPhases ?? []).length ? 'is-selected' : ''}`}
                                      disabled={!isAdmin}
                                      type="button"
                                      onClick={() => updateRecipient({ interviewPhases: [] })}
                                    >
                                      Todas as fases
                                    </button>
                                    {interviewPhases.map(option => {
                                      const selected = (recipient.interviewPhases ?? []).includes(option.value);
                                      return (
                                        <button
                                          className={`flow-event-chip ${selected ? 'is-selected' : ''}`}
                                          disabled={!isAdmin}
                                          key={option.value}
                                          type="button"
                                          onClick={() =>
                                            updateRecipient({
                                              interviewPhases: selected
                                                ? recipient.interviewPhases.filter(value => value !== option.value)
                                                : [...(recipient.interviewPhases ?? []), option.value],
                                            })
                                          }
                                        >
                                          {option.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                                <div className="flow-notification-scope">
                                  <strong>Eventos avisados</strong>
                                  <div
                                    className="flow-notification-events"
                                    aria-label={`Eventos do destinatário ${recipientIndex + 1}`}
                                  >
                                    {appointmentNotificationEventOptions.map(option => (
                                      <label
                                        className={`flow-event-chip ${recipient.events.includes(option.value) ? 'is-selected' : ''}`}
                                        key={option.value}
                                      >
                                        <input
                                          checked={recipient.events.includes(option.value)}
                                          disabled={!isAdmin}
                                          type="checkbox"
                                          onChange={event =>
                                            updateRecipient({
                                              events: event.target.checked
                                                ? [...recipient.events, option.value]
                                                : recipient.events.filter(value => value !== option.value),
                                            })
                                          }
                                        />
                                        {option.label}
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="flow-notification-empty">
                        Nenhum telefone configurado. Nenhum aviso interno será enviado.
                      </p>
                    )}
                  </section>
                  {isAdmin && (
                    <button className="btn-secondary" type="button" onClick={() => void saveDiagramMessages()}>
                      <Save size={15} /> Salvar identidade e avisos
                    </button>
                  )}
                </section>
                <div className="talent-fields-title">
                  <div>
                    <h3>Configuração detalhada das perguntas</h3>
                    <small>
                      Edite perguntas e mensagens na mesma ordem da conversa. Tipos, validações e condições continuam
                      sincronizados com o Diagrama.
                    </small>
                  </div>
                </div>
                <div className="question-list">
                  {editableFlowNodes.map((node, flowPosition) => {
                    if (node.type === 'message') {
                      return (
                        <article
                          className={`question-card message-question-card ${expandedFlowNodeId === node.id ? 'expanded' : ''} ${dragOverFlowNodeId === node.id ? 'drag-over' : ''} ${flowDragPreview?.nodeId === node.id ? 'dragging-source' : ''}`}
                          key={node.id}
                          onPointerEnter={() => enterFlowCardPointerTarget(node.id)}
                          onPointerUp={() => finishFlowCardPointer(node.id)}
                        >
                          <header
                            className="question-card-header message-card-header draggable-card-header"
                            title={isAdmin ? 'Segure e arraste este cabeçalho para mover a mensagem' : undefined}
                            role="button"
                            tabIndex={0}
                            aria-expanded={expandedFlowNodeId === node.id}
                            onClick={event => {
                              if ((event.target as HTMLElement).closest('button')) return;
                              if (Date.now() < suppressFlowCardClickUntil.current) return;
                              setExpandedFlowNodeId(current => (current === node.id ? null : node.id));
                            }}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setExpandedFlowNodeId(current => (current === node.id ? null : node.id));
                              }
                            }}
                            onPointerDown={event => beginFlowCardPointer(event, node.id)}
                          >
                            <div>
                              <span className="question-number message-number">
                                <MessageSquareText size={16} />
                              </span>
                              <div>
                                <strong>{node.data.label || 'Mensagem sem título'}</strong>
                                <small>Mensagem inserida entre as perguntas do fluxo</small>
                              </div>
                            </div>
                            <div className="talent-row-actions">
                              {isAdmin && (
                                <>
                                  <button
                                    className="btn-secondary compact"
                                    type="button"
                                    disabled={flowPosition === 0}
                                    onClick={event => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      moveDraftFlowNode(node.id, -1);
                                    }}
                                    aria-label="Mover mensagem para cima"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    className="btn-secondary compact"
                                    type="button"
                                    disabled={flowPosition === editableFlowNodes.length - 1}
                                    onClick={event => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      moveDraftFlowNode(node.id, 1);
                                    }}
                                    aria-label="Mover mensagem para baixo"
                                  >
                                    ↓
                                  </button>
                                  <button
                                    className="icon-danger"
                                    type="button"
                                    onClick={event => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      removeDraftMessage(node.id);
                                    }}
                                    aria-label="Excluir mensagem"
                                    title="Excluir mensagem"
                                  >
                                    <Trash2 size={17} />
                                  </button>
                                </>
                              )}
                              {expandedFlowNodeId === node.id ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                            </div>
                          </header>
                          {expandedFlowNodeId === node.id && (
                            <div className="question-card-body message-card-body">
                              <label>
                                <span>Nome interno</span>
                                <input
                                  value={node.data.label ?? ''}
                                  disabled={!isAdmin}
                                  onChange={event => {
                                    setDraftGraph(graph => ({
                                      ...graph,
                                      nodes: graph.nodes.map(item =>
                                        item.id === node.id
                                          ? { ...item, data: { ...item.data, label: event.target.value } }
                                          : item,
                                      ),
                                    }));
                                    setDraftDirty(true);
                                  }}
                                />
                              </label>
                              <label>
                                <span>Mensagem enviada no WhatsApp</span>
                                <textarea
                                  rows={4}
                                  value={node.data.text ?? ''}
                                  disabled={!isAdmin}
                                  onChange={event => {
                                    setDraftGraph(graph => ({
                                      ...graph,
                                      nodes: graph.nodes.map(item =>
                                        item.id === node.id
                                          ? { ...item, data: { ...item.data, text: event.target.value } }
                                          : item,
                                      ),
                                    }));
                                    setDraftDirty(true);
                                  }}
                                />
                              </label>
                            </div>
                          )}
                        </article>
                      );
                    }
                    const index = draftFields.findIndex(item => item.id === node.data.fieldId);
                    const field = index >= 0 ? draftFields[index] : undefined;
                    if (!field) return null;
                    return (
                      <article
                        className={`question-card ${expandedFlowNodeId === node.id ? 'expanded' : ''} ${dragOverFlowNodeId === node.id ? 'drag-over' : ''} ${flowDragPreview?.nodeId === node.id ? 'dragging-source' : ''}`}
                        key={field.id}
                        onPointerEnter={() => enterFlowCardPointerTarget(node.id)}
                        onPointerUp={() => finishFlowCardPointer(node.id)}
                      >
                        <header
                          className="question-card-header draggable-card-header"
                          title={isAdmin ? 'Segure e arraste este cabeçalho para mover a pergunta' : undefined}
                          role="button"
                          tabIndex={0}
                          aria-expanded={expandedFlowNodeId === node.id}
                          onClick={event => {
                            if ((event.target as HTMLElement).closest('button')) return;
                            if (Date.now() < suppressFlowCardClickUntil.current) return;
                            setExpandedFlowNodeId(current => (current === node.id ? null : node.id));
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setExpandedFlowNodeId(current => (current === node.id ? null : node.id));
                            }
                          }}
                          onPointerDown={event => beginFlowCardPointer(event, node.id)}
                        >
                          <div>
                            <span className="question-number">{index + 1}</span>
                            <div>
                              <strong>{field.label || 'Pergunta sem título'}</strong>
                              <small>
                                {responseTypeLabel(field)}
                                {field.required ? ' · Obrigatória' : ' · Opcional'}
                              </small>
                              {field.visibleWhen && (
                                <span className="question-path-label">
                                  <GitBranch size={13} />
                                  Caminho:{' '}
                                  {draftFields.find(item => item.id === field.visibleWhen?.fieldId)?.label ??
                                    'Pergunta anterior'}{' '}
                                  {field.visibleWhen.operator === 'filled'
                                    ? 'foi respondida'
                                    : `→ ${String(field.visibleWhen.value ?? '')}`}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="talent-row-actions">
                            {expandedFlowNodeId === node.id && <span className="editing-badge">Editando agora</span>}
                            <button
                              className="btn-secondary compact"
                              type="button"
                              onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                moveDraftFlowNode(node.id, -1);
                              }}
                              disabled={flowPosition === 0}
                              aria-label="Mover pergunta para cima"
                            >
                              ↑
                            </button>
                            <button
                              className="btn-secondary compact"
                              type="button"
                              onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                moveDraftFlowNode(node.id, 1);
                              }}
                              disabled={flowPosition === editableFlowNodes.length - 1}
                              aria-label="Mover pergunta para baixo"
                            >
                              ↓
                            </button>
                            <button
                              className="icon-danger"
                              type="button"
                              onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                setDraftDirty(true);
                                setDraftFields(fields => fields.filter((_, position) => position !== index));
                                setExpandedFlowNodeId(current => (current === node.id ? null : current));
                              }}
                              aria-label="Excluir pergunta"
                              title="Excluir pergunta"
                            >
                              <Trash2 size={17} />
                            </button>
                            {expandedFlowNodeId === node.id ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                          </div>
                        </header>

                        {expandedFlowNodeId === node.id && (
                          <div className="question-card-body">
                            <div className="question-main-grid">
                              <label>
                                <span>Título interno</span>
                                <input
                                  value={field.label}
                                  onChange={e => patchDraftFieldLabel(index, e.target.value)}
                                  placeholder="Ex.: Área de interesse"
                                />
                              </label>
                              <label>
                                <span>Tipo de resposta</span>
                                <select
                                  value={responseTypeValue(field)}
                                  onChange={e => {
                                    const preset = addressResponseTypes.find(
                                      item => addressResponseTypeValue(item.answerKey) === e.target.value,
                                    );
                                    if (preset) {
                                      patchDraftField(index, {
                                        type: preset.type,
                                        answerKey: preset.answerKey,
                                        options: preset.options,
                                        validationScript: preset.validationScript,
                                      });
                                      return;
                                    }
                                    const wasAddressType = addressResponseTypes.some(
                                      item => item.answerKey === field.answerKey,
                                    );
                                    patchDraftField(index, {
                                      type: e.target.value as WorkflowField['type'],
                                      ...(e.target.value !== 'select' ? { talentPoolOption: undefined } : {}),
                                      ...(wasAddressType ? { validationScript: undefined, options: undefined } : {}),
                                    });
                                  }}
                                >
                                  {fieldTypeGroups.map(group => (
                                    <optgroup key={group.label} label={group.label}>
                                      {group.values.map(value => {
                                        const type = fieldTypes.find(item => item.value === value)!;
                                        return (
                                          <option key={type.value} value={type.value}>
                                            {type.label}
                                          </option>
                                        );
                                      })}
                                    </optgroup>
                                  ))}
                                  <optgroup label="Campos de endereço">
                                    {addressResponseTypes.map(type => (
                                      <option
                                        key={type.answerKey}
                                        value={addressResponseTypeValue(type.answerKey)}
                                        disabled={draftFields.some(
                                          item => item.id !== field.id && item.answerKey === type.answerKey,
                                        )}
                                      >
                                        {type.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                </select>
                              </label>
                              <label className="question-prompt">
                                <span>Pergunta enviada no WhatsApp</span>
                                <textarea
                                  rows={2}
                                  value={field.prompt}
                                  onChange={e => patchDraftField(index, { prompt: e.target.value })}
                                  placeholder="Ex.: Qual área você deseja escolher?"
                                />
                              </label>
                              {(field.type === 'select' ||
                                field.type === 'multiselect' ||
                                field.type === 'appointment') && (
                                <div className="question-options-marker-help">
                                  <button
                                    className="btn-secondary compact"
                                    type="button"
                                    disabled={/\{(?:opções|opcoes)\}/i.test(field.prompt)}
                                    onClick={() =>
                                      patchDraftField(index, {
                                        prompt: `${field.prompt.trimEnd()}\n\n{opções}`,
                                      })
                                    }
                                  >
                                    Inserir {'{opções}'}
                                  </button>
                                  <small>
                                    Posicione <code>{'{opções}'}</code> no ponto exato em que a lista numerada deve
                                    aparecer. Sem o marcador, ela continua sendo exibida depois da pergunta.
                                  </small>
                                </div>
                              )}
                              <label>
                                <span>Salvar resposta no campo</span>
                                <input
                                  value={field.answerKey ?? field.id}
                                  readOnly={addressResponseTypes.some(type => type.answerKey === field.answerKey)}
                                  onChange={e => patchDraftField(index, { answerKey: e.target.value })}
                                  onBlur={e =>
                                    patchDraftField(index, {
                                      answerKey: normalizeAnswerKey(e.target.value || field.label),
                                    })
                                  }
                                  placeholder="Ex.: area_interesse"
                                />
                                <small>
                                  {addressResponseTypes.some(type => type.answerKey === field.answerKey)
                                    ? 'Este campo de endereço usa uma chave padronizada para integrações e proximidade.'
                                    : 'Padrão: letras minúsculas, sem acentos e separadas por _. Ex.: area_interesse. Reutilize somente em caminhos mutuamente exclusivos.'}
                                </small>
                              </label>
                            </div>

                            {(field.type === 'select' || field.type === 'multiselect') && (
                              <section className="option-editor">
                                <div className="option-editor-title">
                                  <div>
                                    <strong>Opções de resposta</strong>
                                    <small>O WhatsApp exibirá e aceitará automaticamente os números 1, 2, 3…</small>
                                  </div>
                                  <button className="btn-secondary" type="button" onClick={() => addFieldOption(index)}>
                                    <Plus size={15} /> Adicionar opção
                                  </button>
                                </div>
                                <div className="option-presets">
                                  <span>Modelos rápidos:</span>
                                  <button type="button" onClick={() => setFieldOptions(index, ['Sim', 'Não'])}>
                                    Sim / Não
                                  </button>
                                  <button type="button" onClick={() => setFieldOptions(index, ['1', '2', '3'])}>
                                    1 / 2 / 3
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setFieldOptions(index, ['Opção 1', 'Opção 2', 'Opção 3'])}
                                  >
                                    3 opções
                                  </button>
                                </div>
                                <div className="option-list">
                                  {(field.options ?? []).map((option, optionIndex) => (
                                    <div className="option-row" key={optionIndex}>
                                      <span>{optionIndex + 1}</span>
                                      <input
                                        value={option}
                                        onChange={e => patchFieldOption(index, optionIndex, e.target.value)}
                                        placeholder={`Texto da opção ${optionIndex + 1}`}
                                      />
                                      <button
                                        className="icon-danger"
                                        type="button"
                                        onClick={() => removeFieldOption(index, optionIndex)}
                                      >
                                        Remover
                                      </button>
                                    </div>
                                  ))}
                                  {!field.options?.length && (
                                    <button
                                      className="empty-options"
                                      type="button"
                                      onClick={() => addFieldOption(index)}
                                    >
                                      + Criar a primeira opção
                                    </button>
                                  )}
                                </div>
                                {field.type === 'select' &&
                                  ['area_interesse', 'area_de_interesse'].some(identifier =>
                                    normalizeAnswerKey(field.answerKey ?? field.label).includes(identifier),
                                  ) && (
                                    <label className="talent-pool-option-selector">
                                      <span>Opção que representa o Banco de Talentos</span>
                                      <select
                                        value={field.talentPoolOption ?? ''}
                                        onChange={event =>
                                          patchDraftField(index, {
                                            talentPoolOption: event.target.value || undefined,
                                          })
                                        }
                                      >
                                        <option value="">Nenhuma opção</option>
                                        {(field.options ?? []).filter(Boolean).map(option => (
                                          <option key={option} value={option}>
                                            {option}
                                          </option>
                                        ))}
                                      </select>
                                      <small>
                                        O cadastro continua no mesmo fluxo, mas será identificado como candidato para
                                        oportunidades futuras. Nas perguntas seguintes, use o filtro de exibição
                                        “igual a” esta opção para criar o caminho específico sem mudar o padrão do
                                        formulário.
                                      </small>
                                    </label>
                                  )}
                              </section>
                            )}

                            <section className="visibility-editor">
                              <div>
                                <strong>Filtro adicional de exibição</strong>
                                <small>
                                  Regra avançada preservada dos fluxos antigos. Ela pode ocultar a pergunta mesmo quando
                                  o caminho do diagrama chegar até aqui.
                                </small>
                              </div>
                              <div className="visibility-controls">
                                <select
                                  aria-label={`Pergunta da qual “${field.label}” depende`}
                                  value={field.visibleWhen?.fieldId ?? ''}
                                  onChange={e =>
                                    patchDraftField(index, {
                                      visibleWhen: e.target.value
                                        ? {
                                            fieldId: e.target.value,
                                            operator: field.visibleWhen?.operator ?? 'equals',
                                            value: undefined,
                                          }
                                        : undefined,
                                    })
                                  }
                                >
                                  <option value="">Sem filtro adicional</option>
                                  {draftFields.slice(0, index).map(option => (
                                    <option key={option.id} value={option.id}>
                                      Depende de: {option.label}
                                    </option>
                                  ))}
                                </select>
                                {field.visibleWhen && (
                                  <>
                                    <select
                                      aria-label={`Condição para mostrar “${field.label}”`}
                                      value={field.visibleWhen.operator}
                                      onChange={e =>
                                        patchDraftField(index, {
                                          visibleWhen: {
                                            ...field.visibleWhen!,
                                            operator: e.target.value as NonNullable<
                                              WorkflowField['visibleWhen']
                                            >['operator'],
                                          },
                                        })
                                      }
                                    >
                                      <option value="equals">Resposta for igual a</option>
                                      <option value="notEquals">Resposta for diferente de</option>
                                      <option value="contains">Resposta contiver</option>
                                      <option value="filled">Resposta estiver preenchida</option>
                                    </select>
                                    {field.visibleWhen.operator !== 'filled' &&
                                      (draftFields.find(option => option.id === field.visibleWhen?.fieldId)?.options
                                        ?.length ? (
                                        <select
                                          aria-label={`Resposta que mostra “${field.label}”`}
                                          value={String(field.visibleWhen.value ?? '')}
                                          onChange={e =>
                                            patchDraftField(index, {
                                              visibleWhen: { ...field.visibleWhen!, value: e.target.value },
                                            })
                                          }
                                        >
                                          <option value="">Escolha a resposta</option>
                                          {draftFields
                                            .find(option => option.id === field.visibleWhen?.fieldId)
                                            ?.options?.filter(Boolean)
                                            .map(option => (
                                              <option key={option} value={option}>
                                                {option}
                                              </option>
                                            ))}
                                        </select>
                                      ) : (
                                        <input
                                          value={String(field.visibleWhen.value ?? '')}
                                          onChange={e =>
                                            patchDraftField(index, {
                                              visibleWhen: { ...field.visibleWhen!, value: e.target.value },
                                            })
                                          }
                                          placeholder="Valor da resposta"
                                        />
                                      ))}
                                  </>
                                )}
                              </div>
                            </section>

                            <details className="question-advanced">
                              <summary>Configurações avançadas</summary>
                              <label className="technical-id-field">
                                <span>ID interno automático da etapa</span>
                                <input value={field.id} readOnly />
                                <small>Usado internamente nas ramificações. Não precisa ser alterado.</small>
                              </label>
                              <div className="question-flags">
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={field.required}
                                    onChange={e => patchDraftField(index, { required: e.target.checked })}
                                  />{' '}
                                  Obrigatória
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={field.customerVisible !== false}
                                    onChange={e => patchDraftField(index, { customerVisible: e.target.checked })}
                                  />{' '}
                                  Visível ao cliente
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={field.customerEditable !== false}
                                    onChange={e => patchDraftField(index, { customerEditable: e.target.checked })}
                                  />{' '}
                                  Cliente pode editar
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={field.confidential === true}
                                    onChange={e => patchDraftField(index, { confidential: e.target.checked })}
                                  />{' '}
                                  Confidencial
                                </label>
                              </div>
                              <label className="script-field">
                                <span>Validação JavaScript opcional</span>
                                <textarea
                                  rows={4}
                                  value={field.validationScript ?? ''}
                                  onChange={e =>
                                    patchDraftField(index, { validationScript: e.target.value || undefined })
                                  }
                                  placeholder="Use somente quando as validações padrão não forem suficientes."
                                />
                              </label>
                            </details>
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {!draftFields.length && (
                    <div className="empty-questions">
                      <strong>Este fluxo ainda não tem perguntas.</strong>
                      <span>Adicione a primeira pergunta para montar a conversa.</span>
                    </div>
                  )}
                </div>
                {isAdmin && (
                  <div className="talent-row-actions flow-create-actions flow-create-actions-bottom">
                    <button className="btn-secondary" type="button" onClick={addDraftMessage}>
                      <MessageSquareText size={16} /> Adicionar mensagem
                    </button>
                    <button className="btn-primary" type="button" onClick={addDraftQuestion}>
                      <Plus size={16} /> Adicionar pergunta
                    </button>
                  </div>
                )}
                <div className="flow-save-bar">
                  <div className="flow-save-state">
                    <strong>{draftDirty ? 'Você tem alterações pendentes' : 'Rascunho atualizado'}</strong>
                    <small>
                      {draftDirty ? 'Salve antes de trocar de fluxo.' : 'Todas as alterações locais foram salvas.'}
                    </small>
                  </div>
                  <div className="talent-row-actions">
                    <button
                      className="btn-primary"
                      onClick={() => void saveFlowDraft()}
                      disabled={!draftDirty || savingDraft}
                    >
                      <Save size={16} /> Salvar rascunho
                    </button>
                    <button className="btn-secondary" onClick={() => void publishSelectedFlow()} disabled={savingDraft}>
                      Publicar alterações
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={async () => {
                        await workflowHubApi.duplicate(sessionId, selectedFlow.id);
                        await load();
                      }}
                    >
                      <Copy size={16} /> Duplicar
                    </button>
                    {selectedFlow.status === 'PUBLICADA' && (
                      <button
                        className="btn-secondary"
                        onClick={async () => {
                          await workflowHubApi.pause(sessionId, selectedFlow.id);
                          await load();
                        }}
                      >
                        Pausar
                      </button>
                    )}
                    {selectedFlow.status === 'PAUSADA' && (
                      <button
                        className="btn-primary"
                        onClick={async () => {
                          try {
                            await workflowHubApi.resume(sessionId, selectedFlow.id);
                            toast.success('Fluxo reativado');
                            await load();
                          } catch (error) {
                            toast.error(error instanceof Error ? error.message : 'Não foi possível reativar o fluxo');
                          }
                        }}
                      >
                        Reativar fluxo
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flow-editor-empty">
                <GitBranch size={36} />
                <h2>Selecione um fluxo</h2>
                <p>Escolha um item na lista ao lado para editar suas perguntas e caminhos.</p>
              </div>
            )}
          </main>
        </div>
      )}

      {tab === 'diagram' && (
        <section className="diagram-page">
          <header className="diagram-page-header">
            <div>
              <span className="section-eyebrow">Visão completa da automação</span>
              <h2>
                <GitBranch size={23} /> Diagrama da conversa
              </h2>
              <p>
                Veja o que será enviado no WhatsApp, organize os caminhos e edite as mensagens automáticas no mesmo
                lugar.
              </p>
            </div>
            <label className="diagram-flow-selector">
              <span>Fluxo visualizado</span>
              <select value={selectedFlowId} onChange={event => selectFlow(event.target.value)}>
                {flows.map(flow => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </select>
            </label>
          </header>

          {selectedFlow ? (
            <>
              <div className="diagram-legend" aria-label="Legenda do diagrama">
                <span>
                  <i className="diagram-legend-dot system" /> Mensagem do sistema
                </span>
                <span>
                  <i className="diagram-legend-dot question" /> Pergunta e caminho
                </span>
                <span>
                  <i className="diagram-legend-dot event" /> Evento automático
                </span>
              </div>

              <article
                className={`diagram-section diagram-section-graph ${diagramGraphExpanded ? 'is-expanded' : 'is-collapsed'}`}
              >
                <header
                  className="diagram-section-header diagram-section-toggle"
                  role="button"
                  tabIndex={0}
                  aria-expanded={diagramGraphExpanded}
                  aria-controls="diagram-questions-and-paths"
                  onClick={() => setDiagramGraphExpanded(current => !current)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setDiagramGraphExpanded(current => !current);
                  }}
                >
                  <div>
                    <span className="diagram-step-number">1</span>
                    <div>
                      <h3>Perguntas e caminhos</h3>
                      <p>Arraste as etapas e conecte cada resposta ao próximo ponto da conversa.</p>
                    </div>
                  </div>
                  <div
                    className="diagram-history-actions"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                  >
                    {draftDirty && <span className="unsaved-badge">Alterações não salvas</span>}
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={undoDiagram}
                      disabled={!editorHistory.past.length}
                      title="Desfazer a última alteração do diagrama"
                    >
                      <Undo2 size={15} /> Desfazer
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={redoDiagram}
                      disabled={!editorHistory.future.length}
                      title="Refazer a alteração desfeita"
                    >
                      <Redo2 size={15} /> Refazer
                    </button>
                    {isAdmin && (
                      <button
                        className="btn-primary"
                        onClick={() => void saveFlowDraft()}
                        disabled={!draftDirty || savingDraft}
                        title={draftDirty ? 'Salvar perguntas e conexões no rascunho' : 'O caminho já está salvo'}
                      >
                        <Save size={16} /> {draftDirty ? 'Salvar caminho' : 'Caminho salvo'}
                      </button>
                    )}
                    <span className="diagram-section-chevron" aria-hidden="true">
                      {diagramGraphExpanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                    </span>
                  </div>
                </header>
                {diagramGraphExpanded && (
                  <div id="diagram-questions-and-paths">
                    <WorkflowDiagram
                      fields={draftFields}
                      graph={visualDraftGraph}
                      editable={isAdmin}
                      onChange={graph => {
                        recordDiagramHistory();
                        setDraftGraph(graph);
                        setDraftFields(fields => orderWorkflowFieldsByGraph(fields, graph));
                        setExpandedFlowNodeId(null);
                        setDraftDirty(true);
                      }}
                      onFieldsChange={fields => {
                        recordDiagramHistory();
                        setDraftFields(fields);
                        setDraftDirty(true);
                      }}
                    />
                    <WorkflowSimulator graph={visualDraftGraph} fields={draftFields} slots={slots} />
                  </div>
                )}
              </article>

              <article className={`diagram-section ${diagramEntryExpanded ? 'is-expanded' : 'is-collapsed'}`}>
                <header
                  className="diagram-section-header diagram-section-toggle"
                  role="button"
                  tabIndex={0}
                  aria-expanded={diagramEntryExpanded}
                  aria-controls="diagram-conversation-entry"
                  onClick={() => setDiagramEntryExpanded(current => !current)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setDiagramEntryExpanded(current => !current);
                  }}
                >
                  <div>
                    <span className="diagram-step-number">2</span>
                    <div>
                      <h3>Entrada da conversa</h3>
                      <p>Mensagens exibidas antes das perguntas do fluxo.</p>
                    </div>
                  </div>
                  <span className="diagram-section-chevron" aria-hidden="true">
                    {diagramEntryExpanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                  </span>
                </header>
                <div id="diagram-conversation-entry" className="diagram-message-row" hidden={!diagramEntryExpanded}>
                  <label className="diagram-message-card system-message">
                    <span className="diagram-message-kind">Menu do setor</span>
                    <strong>Escolha do fluxo</strong>
                    <small>Usada quando a conversa começa sem uma palavra-chave específica.</small>
                    <textarea
                      rows={6}
                      disabled={!isAdmin || !department}
                      value={department?.messages?.sectorMenu ?? ''}
                      placeholder={defaultSectorMenuMessage}
                      onChange={event =>
                        department &&
                        setDepartment({
                          ...department,
                          messages: { ...(department.messages ?? {}), sectorMenu: event.target.value },
                        })
                      }
                    />
                    <DiagramVariableLegend variables="{setor}, {fluxos}" />
                  </label>
                  <span className="diagram-stage-arrow" aria-hidden="true">
                    →
                  </span>
                  {journeyMessageKeys.slice(0, 1).map(key => {
                    const template = flowMessageTemplates.find(item => item.key === key)!;
                    return (
                      <label className="diagram-message-card system-message" key={template.key}>
                        <span className="diagram-message-kind">Início do fluxo</span>
                        <strong>{template.label}</strong>
                        <small>{template.help}</small>
                        <textarea
                          rows={6}
                          disabled={!isAdmin}
                          value={configuredMessages[template.key] ?? ''}
                          placeholder={template.placeholder}
                          onChange={event => updateConfiguredMessage(template.key, event.target.value)}
                        />
                        <DiagramVariableLegend variables={template.variables} />
                      </label>
                    );
                  })}
                </div>
              </article>

              <article className={`diagram-section ${diagramConfirmationExpanded ? 'is-expanded' : 'is-collapsed'}`}>
                <header
                  className="diagram-section-header diagram-section-toggle"
                  role="button"
                  tabIndex={0}
                  aria-expanded={diagramConfirmationExpanded}
                  aria-controls="diagram-confirmation-menu"
                  onClick={() => setDiagramConfirmationExpanded(current => !current)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setDiagramConfirmationExpanded(current => !current);
                  }}
                >
                  <div>
                    <span className="diagram-step-number">3</span>
                    <div>
                      <h3>Confirmação e menu do cliente</h3>
                      <p>Etapas exibidas depois que todas as respostas necessárias forem coletadas.</p>
                    </div>
                  </div>
                  <span className="diagram-section-chevron" aria-hidden="true">
                    {diagramConfirmationExpanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                  </span>
                </header>
                <div
                  id="diagram-confirmation-menu"
                  className="diagram-message-row diagram-message-row-final"
                  hidden={!diagramConfirmationExpanded}
                >
                  {journeyMessageKeys.slice(1).map(key => {
                    const template = flowMessageTemplates.find(item => item.key === key)!;
                    return (
                      <label className="diagram-message-card system-message" key={template.key}>
                        <span className="diagram-message-kind">Antes de salvar</span>
                        <strong>{template.label}</strong>
                        <small>{template.help}</small>
                        <textarea
                          rows={7}
                          disabled={!isAdmin}
                          value={configuredMessages[template.key] ?? ''}
                          placeholder={template.placeholder}
                          onChange={event => updateConfiguredMessage(template.key, event.target.value)}
                        />
                        <DiagramVariableLegend variables={template.variables} />
                      </label>
                    );
                  })}
                  <span className="diagram-stage-arrow" aria-hidden="true">
                    →
                  </span>
                  <div className="diagram-menu-preview">
                    <span className="diagram-message-kind">Depois de salvar</span>
                    <label>
                      <span>Mensagem de conclusão</span>
                      <textarea
                        rows={3}
                        maxLength={500}
                        disabled={!isAdmin}
                        value={configuredMessages.completed ?? ''}
                        placeholder="Dados confirmados e salvos."
                        onChange={event => updateConfiguredMessage('completed', event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Título do menu</span>
                      <input
                        maxLength={120}
                        disabled={!isAdmin}
                        value={recordMenuConfig.title}
                        placeholder={String(flowConfig.name || selectedFlow.name)}
                        onChange={event => updateRecordMenu({ ...recordMenuConfig, title: event.target.value })}
                      />
                    </label>
                    <div className="diagram-menu-actions">
                      {recordMenuConfig.actions.map((item, index) => {
                        const metadata = recordMenuActionDefaults.find(candidate => candidate.action === item.action);
                        return (
                          <div className={item.enabled ? 'enabled' : ''} key={item.action}>
                            <label className="diagram-menu-toggle">
                              <input
                                type="checkbox"
                                disabled={!isAdmin}
                                checked={item.enabled}
                                onChange={event => updateRecordMenuAction(index, { enabled: event.target.checked })}
                              />
                              <span>{index + 1}</span>
                            </label>
                            <input
                              disabled={!isAdmin || !item.enabled}
                              maxLength={80}
                              aria-label={`Texto da opção ${metadata?.label ?? item.action}`}
                              value={item.label}
                              onChange={event => updateRecordMenuAction(index, { label: event.target.value })}
                            />
                            {isAdmin && (
                              <div className="diagram-menu-order">
                                <button
                                  type="button"
                                  className="btn-icon"
                                  disabled={index === 0}
                                  onClick={() => moveRecordMenuAction(index, -1)}
                                  aria-label={`Mover ${metadata?.label ?? item.action} para cima`}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="btn-icon"
                                  disabled={index === recordMenuConfig.actions.length - 1}
                                  onClick={() => moveRecordMenuAction(index, 1)}
                                  aria-label={`Mover ${metadata?.label ?? item.action} para baixo`}
                                >
                                  ↓
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <small>Ative, renomeie e ordene aqui as opções mostradas depois do cadastro.</small>
                  </div>
                </div>
              </article>

              <article className="diagram-section">
                <header className="diagram-section-header">
                  <div>
                    <span className="diagram-step-number event-step">!</span>
                    <div>
                      <h3>Mensagens acionadas por eventos</h3>
                      <p>Elas não seguem uma única linha: aparecem quando o evento correspondente acontece.</p>
                    </div>
                  </div>
                </header>
                <div className="diagram-event-groups">
                  {automaticMessageGroups.map(group => {
                    const expanded = expandedAutomaticMessageGroups.includes(group.id);
                    const contentId = `diagram-event-group-${group.id}`;
                    return (
                      <section
                        className={`diagram-event-group ${expanded ? 'is-expanded' : 'is-collapsed'}`}
                        key={group.id}
                      >
                        <button
                          type="button"
                          className="diagram-event-group-header"
                          aria-expanded={expanded}
                          aria-controls={contentId}
                          onClick={() => toggleAutomaticMessageGroup(group.id)}
                        >
                          <span className="diagram-event-group-icon" aria-hidden="true">
                            <MessageSquareText size={18} />
                          </span>
                          <span className="diagram-event-group-copy">
                            <strong>{group.title}</strong>
                            <small>{group.description}</small>
                          </span>
                          <span className="diagram-event-group-count">{group.keys.length} mensagens</span>
                          <span className="diagram-event-group-chevron" aria-hidden="true">
                            {expanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                          </span>
                        </button>
                        <div id={contentId} className="diagram-event-grid" hidden={!expanded}>
                          {group.keys.map(key => {
                            const template = flowMessageTemplates.find(item => item.key === key)!;
                            return (
                              <label className="diagram-message-card event-message" key={template.key}>
                                <span className="diagram-message-kind">Evento automático</span>
                                <strong>{template.label}</strong>
                                <small>{template.help}</small>
                                <textarea
                                  rows={5}
                                  disabled={!isAdmin}
                                  value={configuredMessages[template.key] ?? ''}
                                  placeholder={template.placeholder}
                                  onChange={event => updateConfiguredMessage(template.key, event.target.value)}
                                />
                                <DiagramVariableLegend variables={template.variables} />
                              </label>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </article>

              {isAdmin && (
                <div className="diagram-save-bar">
                  <div>
                    <strong>Mensagens e publicação</strong>
                    <span>Salve os textos e o menu ou publique o rascunho já salvo acima.</span>
                  </div>
                  <div className="talent-row-actions">
                    <button className="btn-secondary" onClick={() => void saveDiagramMessages()}>
                      <MessageSquareText size={16} /> Salvar textos e menu
                    </button>
                    <button
                      className="btn-secondary"
                      title="Salva o rascunho atual e publica a versão"
                      onClick={() => void publishSelectedFlow()}
                      disabled={savingDraft}
                    >
                      Salvar e publicar
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flow-editor-empty diagram-empty">
              <GitBranch size={40} />
              <h2>Nenhum fluxo selecionado</h2>
              <p>Crie ou selecione um fluxo para montar o diagrama da conversa.</p>
              <button className="btn-primary" onClick={() => setTab('flows')}>
                Ir para Fluxos
              </button>
            </div>
          )}
        </section>
      )}

      {tab === 'agenda' && (
        <section className="talent-card agenda-workspace">
          <div className="agenda-heading">
            <div>
              <h2>
                <CalendarDays size={21} /> Agenda de entrevistas
              </h2>
              <p>Crie horários, defina a capacidade e acompanhe as confirmações em um só lugar.</p>
            </div>
          </div>
          {isAdmin && (
            <details className="agenda-location-manager">
              <summary>Gerenciar locais</summary>
              {agendaLocations.length > 0 && (
                <div className="agenda-location-list">
                  {agendaLocations.map(location => {
                    const isEditing = locationEditorOpen && editingLocationId === location.id;
                    return (
                      <div className="agenda-location-list-item" key={location.id}>
                        <button
                          className={isEditing ? 'agenda-location-summary is-editing' : 'agenda-location-summary'}
                          type="button"
                          aria-expanded={isEditing}
                          aria-controls={`agenda-location-editor-${location.id}`}
                          onClick={() => toggleAgendaLocationEditor(location)}
                        >
                          <span>
                            <strong>{location.internalName || location.name}</strong>
                            <small>
                              {location.name}
                              {location.address ? ` · ${location.address}` : ''}
                            </small>
                            {!!location.notificationContacts?.length && (
                              <small>
                                {location.notificationContacts
                                  .map(contact => `${contact.role}: ${contact.name}`)
                                  .join(' · ')}
                              </small>
                            )}
                          </span>
                          <span className="agenda-location-summary-action" aria-hidden="true">
                            <Pencil size={15} /> {isEditing ? 'Recolher' : 'Editar'}
                            {isEditing ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </span>
                        </button>
                        {isEditing && renderAgendaLocationEditor(`agenda-location-editor-${location.id}`)}
                      </div>
                    );
                  })}
                </div>
              )}
              {!locationEditorOpen && (
                <button
                  className="btn-secondary agenda-location-add"
                  type="button"
                  onClick={openNewAgendaLocationEditor}
                >
                  <Plus size={16} /> Cadastrar novo local
                </button>
              )}
              {locationEditorOpen && editingLocationId === null && renderAgendaLocationEditor()}
            </details>
          )}
          <div className="agenda-builder">
            <label>
              Fluxo
              <select value={selectedFlowId} onChange={event => selectFlow(event.target.value)}>
                {flows.map(flow => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Data e horário
              <WorkflowDateTimePicker
                id="workflow-slot-date"
                ariaLabel="Data e horário da entrevista"
                value={slotDate}
                onChange={setSlotDate}
              />
            </label>
            <label>
              Fase da entrevista
              <select
                value={slotInterviewPhase}
                onChange={event => setSlotInterviewPhase(event.target.value as WorkflowInterviewPhase)}
              >
                {interviewPhases.map(phase => (
                  <option key={phase.value} value={phase.value}>
                    {phase.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Local
              <select
                value={slotLocationId}
                onChange={event =>
                  selectAgendaLocation(agendaLocations.find(location => location.id === event.target.value))
                }
              >
                <option value="">Selecione um local</option>
                {agendaLocations.map(location => (
                  <option key={location.id} value={location.id}>
                    {location.internalName || location.name}
                    {location.internalName ? ` — ${location.name}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Endereço
              <input
                maxLength={500}
                value={slotAddress}
                readOnly
                aria-readonly="true"
                placeholder="Endereço escrito do local"
                title="O endereço é definido no cadastro do local"
              />
            </label>
            <label>
              Instrução
              <input
                maxLength={1000}
                value={slotInstruction}
                onChange={event => setSlotInstruction(event.target.value)}
                placeholder="Ex.: Apresente-se na recepção"
              />
            </label>
            <label>
              Apresentar-se para
              <input
                maxLength={160}
                value={slotResponsible}
                onChange={event => setSlotResponsible(event.target.value)}
                placeholder="Ex.: Amanda"
              />
            </label>
            <label className="slot-capacity-field">
              Limite de pessoas
              <input
                type="number"
                min="1"
                max="1000"
                value={slotCapacity}
                onChange={event => setSlotCapacity(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <button
              className="btn-primary"
              disabled={!selectedFlow || !slotDate || !slotLocationId || creatingSlot}
              onClick={() => void addSlot()}
            >
              <Plus size={16} /> {creatingSlot ? 'Salvando...' : 'Disponibilizar horário'}
            </button>
          </div>
          <div className="agenda-stats">
            <div>
              <span>Horários disponíveis</span>
              <strong>{currentAgendaSlots.filter(slot => slot.status === 'DISPONIVEL').length}</strong>
            </div>
            <div>
              <span>Vagas restantes</span>
              <strong>
                {currentAgendaSlots.reduce((total, slot) => total + Math.max(0, slot.capacity - slot.bookedCount), 0)}
              </strong>
            </div>
            <div>
              <span>Agendamentos confirmados</span>
              <strong>{appointments.filter(item => item.status === 'CONFIRMADO').length}</strong>
            </div>
          </div>
          <div className="agenda-table-card">
            <div className="agenda-section-title">
              <div>
                <h3>Horários cadastrados</h3>
                <span>Horários passados são concluídos e ficam ocultos para não poluir a agenda.</span>
              </div>
              <div className="agenda-section-actions">
                <select
                  value={agendaLocationFilter}
                  onChange={event => setAgendaLocationFilter(event.target.value)}
                  aria-label="Filtrar horários por local"
                >
                  <option value="all">Todos os locais</option>
                  {agendaLocationOptions.map(location => (
                    <option key={location} value={location}>
                      {location}
                    </option>
                  ))}
                </select>
                {pastAgendaSlots.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary compact"
                    onClick={() => setShowPastSlots(value => !value)}
                  >
                    {showPastSlots ? 'Ocultar passados' : `Mostrar passados (${pastAgendaSlots.length})`}
                  </button>
                )}
              </div>
            </div>
            <div className="agenda-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th
                      aria-sort={
                        agendaSlotSort === 'date-asc'
                          ? 'ascending'
                          : agendaSlotSort === 'date-desc'
                            ? 'descending'
                            : 'none'
                      }
                    >
                      <button
                        type="button"
                        className={`agenda-table-sort ${agendaSlotSort.startsWith('date') ? 'active' : ''}`}
                        onClick={() =>
                          setAgendaSlotSort(current => (current === 'date-asc' ? 'date-desc' : 'date-asc'))
                        }
                        title="Alternar ordem da data"
                      >
                        Data e hora
                        {agendaSlotSort === 'date-desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
                      </button>
                    </th>
                    <th>Fase</th>
                    <th
                      aria-sort={
                        agendaSlotSort === 'location-asc'
                          ? 'ascending'
                          : agendaSlotSort === 'location-desc'
                            ? 'descending'
                            : 'none'
                      }
                    >
                      <button
                        type="button"
                        className={`agenda-table-sort ${agendaSlotSort.startsWith('location') ? 'active' : ''}`}
                        onClick={() =>
                          setAgendaSlotSort(current => (current === 'location-asc' ? 'location-desc' : 'location-asc'))
                        }
                        title="Alternar ordem alfabética do local"
                      >
                        Local
                        {agendaSlotSort === 'location-desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
                      </button>
                    </th>
                    <th>Endereço</th>
                    <th>Instrução</th>
                    <th>Apresentar-se para</th>
                    <th>Ocupação</th>
                    <th>Vagas restantes</th>
                    <th>Status</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAgendaSlots.map(slot => {
                    const isPastSlot = Date.parse(slot.startsAt) <= Date.now();
                    return (
                      <tr key={slot.id}>
                        <td>{new Date(slot.startsAt).toLocaleString('pt-BR')}</td>
                        <td>{interviewPhaseLabel(slot.interviewPhase)}</td>
                        <td>
                          {slot.mapsUrl ? (
                            <a href={slot.mapsUrl} target="_blank" rel="noreferrer">
                              {slot.location || 'Abrir mapa'}
                            </a>
                          ) : (
                            slot.location || '—'
                          )}
                        </td>
                        <td>{slot.address || '—'}</td>
                        <td>{slot.instruction || '—'}</td>
                        <td>{slot.responsible || '—'}</td>
                        <td>
                          {slot.bookedCount} de {slot.capacity}
                        </td>
                        <td>{Math.max(0, slot.capacity - slot.bookedCount)}</td>
                        <td>
                          <span className={`agenda-status ${slot.status.toLocaleLowerCase('pt-BR')}`}>
                            {slot.status}
                          </span>
                        </td>
                        <td>
                          {canWrite && (
                            <div className="talent-row-actions">
                              {!isPastSlot && (
                                <button className="btn-secondary" onClick={() => openSlotEdit(slot)}>
                                  <Pencil size={15} /> Editar
                                </button>
                              )}
                              {!isPastSlot && slot.status !== 'CONFIRMADO' && (
                                <button
                                  className="btn-secondary"
                                  onClick={async () => {
                                    await workflowHubApi.setSlotStatus(
                                      sessionId,
                                      selectedFlowId,
                                      slot.id,
                                      slot.status === 'BLOQUEADO' ? 'DISPONIVEL' : 'BLOQUEADO',
                                    );
                                    await loadAgenda();
                                  }}
                                >
                                  {slot.status === 'BLOQUEADO' ? 'Disponibilizar' : 'Bloquear'}
                                </button>
                              )}
                              <button className="btn-danger" onClick={() => requestSlotRemoval(slot)}>
                                <Trash2 size={15} />{' '}
                                {slot.bookedCount > 0 ||
                                appointments.some(
                                  appointment =>
                                    appointment.status === 'CONFIRMADO' && appointment.slot?.id === slot.id,
                                )
                                  ? 'Reagendar e remover'
                                  : 'Remover'}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!visibleAgendaSlots.length && (
              <p className="agenda-empty">
                {showPastSlots ? 'Nenhum horário cadastrado.' : 'Nenhum horário futuro cadastrado.'}
              </p>
            )}
          </div>
          <div className="agenda-table-card">
            <div className="agenda-section-title">
              <div>
                <h3>Agendamentos</h3>
                <span>Candidatos que escolheram um dos horários disponíveis.</span>
              </div>
              <select
                value={appointmentStatusFilter}
                onChange={event => setAppointmentStatusFilter(event.target.value as 'active' | 'history' | 'all')}
                aria-label="Filtrar agendamentos"
              >
                <option value="active">Ativos</option>
                <option value="history">Histórico</option>
                <option value="all">Todos</option>
              </select>
            </div>
            <div className="agenda-table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      ['contact', 'Contato'],
                      ['startsAt', 'Horário'],
                      ['status', 'Status'],
                      ['reminder', 'Lembrete das 8h'],
                    ].map(([columnId, label]) => (
                      <th
                        key={columnId}
                        aria-sort={
                          appointmentTableSort.columnId === columnId
                            ? appointmentTableSort.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button
                          type="button"
                          className={`table-sort-button ${appointmentTableSort.columnId === columnId ? 'active' : ''}`}
                          onClick={() => setAppointmentTableSort(current => toggleTableSort(current, columnId))}
                        >
                          {label}
                          {appointmentTableSort.columnId === columnId &&
                            (appointmentTableSort.direction === 'desc' ? (
                              <ArrowDown size={14} />
                            ) : (
                              <ArrowUp size={14} />
                            ))}
                        </button>
                      </th>
                    ))}
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAppointments.map(appointment => (
                    <tr key={appointment.id}>
                      <td>{appointmentContact(appointment)}</td>
                      <td>{appointment.slot ? new Date(appointment.slot.startsAt).toLocaleString('pt-BR') : '—'}</td>
                      <td>
                        <span className={`agenda-status ${appointment.status.toLocaleLowerCase('pt-BR')}`}>
                          {appointment.status}
                        </span>
                      </td>
                      <td>
                        {appointment.reminderSentAt
                          ? `Enviado em ${new Date(appointment.reminderSentAt).toLocaleString('pt-BR')}`
                          : 'Pendente'}
                      </td>
                      <td>
                        {canWrite && appointment.status === 'CONFIRMADO' && (
                          <div className="talent-row-actions">
                            <button
                              className="btn-secondary"
                              onClick={() => {
                                setAppointmentTargetSlotId('');
                                setAppointmentPendingReschedule(appointment);
                              }}
                            >
                              Reagendar
                            </button>
                            <button
                              className="btn-secondary"
                              onClick={async () => {
                                await workflowHubApi.setAppointmentStatus(
                                  sessionId,
                                  selectedFlowId,
                                  appointment.id,
                                  'CONCLUIDO',
                                );
                                await loadAgenda();
                              }}
                            >
                              Concluir
                            </button>
                            <button
                              className="btn-secondary"
                              onClick={async () => {
                                await workflowHubApi.setAppointmentStatus(
                                  sessionId,
                                  selectedFlowId,
                                  appointment.id,
                                  'CANCELADO',
                                );
                                toast.success(
                                  'Entrevista cancelada. O cadastro foi atualizado e o candidato será avisado.',
                                );
                                await Promise.all([loadAgenda(), load()]);
                              }}
                            >
                              Cancelar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visibleAppointments.length && <p className="agenda-empty">Nenhum agendamento encontrado neste filtro.</p>}
          </div>
        </section>
      )}

      {tab === 'recruitment' && sessionId && (
        <RecruitmentBoard
          sessionId={sessionId}
          flows={flows}
          canWrite={canWrite}
          onApplicationsChange={setCandidateRecruitmentApplications}
        />
      )}
      {tab === 'recruitment' && !sessionId && (
        <section className="talent-card recruitment-workspace" aria-live="polite">
          <p>Carregando a sessão da Central de Recrutamento…</p>
        </section>
      )}

      {tab === 'talent-bank' && sessionId && (
        <TalentBank
          sessionId={sessionId}
          canWrite={canWrite}
          refreshRevision={candidateProfileRefreshRevision}
          onCandidateSelect={setSelected}
        />
      )}

      {tab === 'candidates' && (
        <section className="talent-card candidate-workspace">
          <div className="candidate-heading">
            <div>
              <h2>
                <Users size={20} /> Candidatos
              </h2>
              <p>Pesquise em qualquer resposta, filtre e clique em uma linha para visualizar o cadastro completo.</p>
            </div>
            <strong>
              {filteredCandidates.length} de {activeCandidates.length}
            </strong>
          </div>
          <div className="candidate-filters">
            <div className="talent-search">
              <Search size={17} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Pesquisar nome, telefone ou qualquer resposta"
              />
            </div>
            <select
              value={candidateFlowFilter}
              onChange={e => setCandidateFlowFilter(e.target.value)}
              aria-label="Filtrar por fluxo"
            >
              <option value="all">Todos os fluxos</option>
              {flows.map(flow => (
                <option key={flow.id} value={flow.id}>
                  {flow.name}
                </option>
              ))}
            </select>
            <select
              value={candidateStatusFilter}
              onChange={e => setCandidateStatusFilter(e.target.value)}
              aria-label="Filtrar por status"
            >
              <option value="all">Todos os status</option>
              {[...new Set(activeCandidates.map(candidate => candidate.status))].map(status => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </div>
          <div className="candidate-table-wrap">
            <table className="candidate-table">
              <thead>
                <tr>
                  {visibleCandidateColumns.map(column => (
                    <th
                      key={column.id}
                      aria-sort={
                        candidateSort.columnId === column.id
                          ? candidateSort.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        className={`table-sort-button ${candidateSort.columnId === column.id ? 'active' : ''}`}
                        onClick={() => setCandidateSort(current => toggleTableSort(current, column.id))}
                      >
                        {column.label}
                        {candidateSort.columnId === column.id &&
                          (candidateSort.direction === 'desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredCandidates.map(candidate => (
                  <tr
                    key={candidate.id}
                    tabIndex={0}
                    onClick={() => setSelected(candidate)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') setSelected(candidate);
                    }}
                  >
                    {visibleCandidateColumns.map(column => (
                      <td key={column.id}>
                        {column.id === 'name' ? (
                          <strong>{candidateTableValue(candidate, column)}</strong>
                        ) : column.id === 'status' || column.id === 'processStatus' ? (
                          <span className="candidate-status" data-status={candidateTableStatus(candidate, column)}>
                            {candidateTableValue(candidate, column)}
                          </span>
                        ) : (
                          candidateTableValue(candidate, column)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredCandidates.length && (
              <div className="candidate-empty">Nenhum candidato corresponde aos filtros.</div>
            )}
          </div>
        </section>
      )}

      {tab === 'tickets' && (
        <section className="talent-card">
          <div className="human-ticket-notifications" aria-live="polite">
            <div className="human-ticket-notifications-header">
              <div>
                <span className="section-eyebrow">Notificações</span>
                <h2>Atendimentos que precisam de atenção</h2>
              </div>
              {humanTicketNotifications.length > 0 && (
                <button className="btn-secondary" type="button" onClick={() => setHumanTicketNotifications([])}>
                  Limpar notificações
                </button>
              )}
            </div>
            {humanTicketNotifications.length > 0 ? (
              <div className="human-ticket-notification-list">
                {humanTicketNotifications.map(notification => {
                  const ticket = tickets.find(item => item.id === notification.ticketId);
                  if (!ticket) return null;
                  return (
                    <button
                      type="button"
                      key={notification.key}
                      className={`human-ticket-notification ${notification.read ? 'is-read' : 'is-unread'}`}
                      onClick={() => {
                        setHumanTicketNotifications(current =>
                          current.map(item => (item.key === notification.key ? { ...item, read: true } : item)),
                        );
                        navigate(
                          `/chats?sessionId=${encodeURIComponent(sessionId)}&chatId=${encodeURIComponent(ticket.chatId)}`,
                        );
                      }}
                    >
                      <span>
                        <strong>
                          {notification.kind === 'new'
                            ? 'Novo atendimento solicitado'
                            : notification.kind === 'activity'
                              ? 'Nova atividade no atendimento'
                              : 'Status do atendimento alterado'}
                        </strong>
                        <small>{new Date(notification.occurredAt).toLocaleString('pt-BR')}</small>
                      </span>
                      <ExternalLink size={16} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="human-ticket-notifications-empty">Nenhuma nova notificação de atendimento.</p>
            )}
          </div>
          <table>
            <thead>
              <tr>
                {[
                  ['contact', 'Contato'],
                  ['flow', 'Fluxo'],
                  ['status', 'Status'],
                  ['lastRelevantAt', 'Última atividade'],
                ].map(([columnId, label]) => (
                  <th
                    key={columnId}
                    aria-sort={
                      ticketTableSort.columnId === columnId
                        ? ticketTableSort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      className={`table-sort-button ${ticketTableSort.columnId === columnId ? 'active' : ''}`}
                      onClick={() => setTicketTableSort(current => toggleTableSort(current, columnId))}
                    >
                      {label}
                      {ticketTableSort.columnId === columnId &&
                        (ticketTableSort.direction === 'desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />)}
                    </button>
                  </th>
                ))}
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {sortedTickets.map(ticket => (
                <tr key={ticket.id}>
                  <td>
                    {(() => {
                      const candidate = candidateForTicket(ticket);
                      return (
                        <div className="ticket-contact">
                          <strong>{candidate ? candidateName(candidate) : 'Contato sem cadastro ativo'}</strong>
                          <span>{candidate ? candidateContact(candidate) : displayContactId(ticket.contactId)}</span>
                        </div>
                      );
                    })()}
                  </td>
                  <td>{ticket.instance?.name ?? '—'}</td>
                  <td>{ticket.status}</td>
                  <td>{new Date(ticket.lastRelevantAt).toLocaleString('pt-BR')}</td>
                  <td>
                    <div className="talent-row-actions">
                      <button
                        className="btn-primary"
                        onClick={() =>
                          navigate(
                            `/chats?sessionId=${encodeURIComponent(sessionId)}&chatId=${encodeURIComponent(ticket.chatId)}`,
                          )
                        }
                      >
                        <ExternalLink size={15} /> Abrir conversa
                      </button>
                      <button className="btn-secondary" onClick={() => void showTicketEvents(ticket)}>
                        Histórico
                      </button>
                      {ticket.status !== 'CHAMADO_ENCERRADO' && canWrite && (
                        <>
                          <button className="btn-secondary" onClick={() => void touchTicket(ticket)}>
                            Manter aberto
                          </button>
                          <button className="btn-secondary" onClick={() => void closeTicket(ticket)}>
                            Encerrar
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!tickets.length && <p>Nenhum chamado registrado.</p>}
          {selectedTicket && (
            <div className="talent-ticket-history">
              <h3>
                Histórico do chamado —{' '}
                {candidateForTicket(selectedTicket)
                  ? candidateName(candidateForTicket(selectedTicket) as WorkflowRecord)
                  : displayContactId(selectedTicket.contactId)}
              </h3>
              {ticketEvents.map(event => (
                <div key={event.id}>
                  <strong>{event.type}</strong>
                  <span>{new Date(event.createdAt).toLocaleString('pt-BR')}</span>
                </div>
              ))}
              {!ticketEvents.length && <p>Nenhum evento registrado.</p>}
            </div>
          )}
        </section>
      )}

      {tab === 'notifications' && (isAdmin || role === 'operator') && (
        <section className="talent-card outbox-health">
          <header className="outbox-health-header">
            <div>
              <span className="section-eyebrow">Entrega automática</span>
              <h2>Saúde dos envios</h2>
              <p>Acompanhe mensagens do sistema sem expor destinatários ou o conteúdo enviado.</p>
            </div>
            <button className="btn-secondary" onClick={() => void load({ preserveEditor: true })} disabled={loading}>
              <RefreshCw size={15} /> Atualizar
            </button>
          </header>
          {outboxHealth?.counts ? (
            <>
              <div className="outbox-summary">
                {(
                  [
                    ['Aguardando', outboxHealth.counts.PENDENTE],
                    ['Processando', outboxHealth.counts.PROCESSANDO],
                    ['Nova tentativa', outboxHealth.counts.RETENTANDO],
                    ['Enviadas', outboxHealth.counts.ENVIADA],
                    ['Falhas', outboxHealth.counts.FALHA],
                    ['Canceladas', outboxHealth.counts.CANCELADA],
                  ] as const
                ).map(([label, count]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
              {outboxHealth.pendingDue > 0 && (
                <div className="outbox-warning">
                  {outboxHealth.pendingDue} mensagem(ns) já atingiram o horário de envio e aguardam o OpenWA conectado.
                </div>
              )}
              <h3>Mensagens ainda não enviadas</h3>
              <div className="talent-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Identificador</th>
                      <th>Status</th>
                      <th>Motivo</th>
                      <th>Tentativas</th>
                      <th>Próxima ação</th>
                      <th>Atualizado em</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(outboxHealth.unsent ?? outboxHealth.failures).map(row => (
                      <tr key={row.id}>
                        <td>
                          <code>{row.id.slice(0, 8)}</code>
                        </td>
                        <td>
                          <span className={`outbox-status ${row.status.toLocaleLowerCase('pt-BR')}`}>{row.status}</span>
                        </td>
                        <td>
                          {row.reason
                            ? (
                                {
                                  SEM_CONEXAO: 'WhatsApp sem conexão',
                                  TIMEOUT: 'Tempo de envio excedido',
                                  DESTINO_INVALIDO: 'Destino inválido',
                                  FALHA_ENVIO: 'Falha no envio',
                                } as const
                              )[row.reason]
                            : 'Aguardando processamento'}
                        </td>
                        <td>
                          {row.attempts} de {row.maxAttempts}
                          {row.exhausted ? ' — esgotado' : ''}
                        </td>
                        <td>
                          {row.exhausted ? 'Requer análise' : new Date(row.nextAttemptAt).toLocaleString('pt-BR')}
                        </td>
                        <td>{new Date(row.updatedAt).toLocaleString('pt-BR')}</td>
                        <td>
                          <div className="talent-row-actions">
                            {row.status !== 'PENDENTE' && (
                              <button
                                type="button"
                                className="btn-secondary compact"
                                onClick={() => setOutboxPendingAction({ row, action: 'retry' })}
                              >
                                Tentar agora
                              </button>
                            )}
                            <button
                              type="button"
                              className="icon-danger"
                              onClick={() => setOutboxPendingAction({ row, action: 'discard' })}
                            >
                              Descartar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!(outboxHealth.unsent ?? outboxHealth.failures).length && <p>Nenhum envio pendente ou em falha.</p>}
              <small className="outbox-privacy-note">
                O painel não mostra telefone, conversa, texto da mensagem nem o erro bruto. “Tentar agora” reutiliza o
                mesmo registro e a mesma chave de idempotência; “Descartar” cancela o envio e preserva o histórico
                técnico.
              </small>
            </>
          ) : (
            <p>Carregando a situação dos envios…</p>
          )}
        </section>
      )}

      {tab === 'privacy' && (
        <section className="talent-card">
          <h2>Solicitações de exclusão</h2>
          <div className="privacy-retention-policy">
            <strong>Política de exclusão e retenção</strong>
            <p>
              Ao aprovar, os dados pessoais, mensagens, agendamentos e vínculos identificáveis são excluídos. O sistema
              preserva somente eventos técnicos pseudonimizados indispensáveis para segurança, auditoria e comprovação
              da exclusão, por até {runtimeStatus?.technicalRetentionDays ?? 365} dias.
            </p>
          </div>
          <table>
            <thead>
              <tr>
                <th>Cadastro</th>
                <th>Solicitada em</th>
                <th>Status</th>
                <th>Decisão</th>
              </tr>
            </thead>
            <tbody>
              {deletionRequests.map(request => (
                <tr key={request.id}>
                  <td>{request.recordId}</td>
                  <td>{new Date(request.createdAt).toLocaleString('pt-BR')}</td>
                  <td>{request.status}</td>
                  <td>
                    {request.status === 'PENDENTE' && (
                      <div className="talent-row-actions">
                        <button
                          className="btn-secondary"
                          onClick={async () => {
                            await workflowHubApi.decideDeletion(sessionId, request.id, false);
                            await load();
                          }}
                        >
                          Rejeitar
                        </button>
                        <button className="btn-primary" onClick={() => setDeletionRequestPendingApprove(request)}>
                          Aprovar exclusão
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deletionRequests.length && <p>Nenhuma solicitação registrada.</p>}
        </section>
      )}

      {tab === 'settings' && selectedFlow && (
        <section className="talent-card talent-settings">
          <div className="settings-intro">
            <div className="settings-intro-icon">
              <Settings2 size={24} />
            </div>
            <div>
              <span className="section-eyebrow">Central de configurações</span>
              <h2>Configuração do setor e do fluxo</h2>
              <p>
                As opções do setor afetam este número do WhatsApp. As demais valem somente para{' '}
                <strong>{selectedFlow.name}</strong>. Perguntas, textos, opções do menu e palavras-chave ficam
                centralizados nas abas Fluxos e Diagrama.
              </p>
              <button type="button" className="btn-secondary" onClick={() => setTab('diagram')}>
                <MessageSquareText size={15} /> Abrir textos da conversa
              </button>
            </div>
          </div>
          <div className="settings-layout">
            {department && (
              <article
                className={`settings-panel settings-panel-wide ${isSettingsCardExpanded('department') ? 'is-expanded' : 'is-collapsed'}`}
              >
                <header className="settings-panel-header" {...settingsCardHeaderProps('department')}>
                  <div className="settings-panel-icon">
                    <Building2 size={20} />
                  </div>
                  <div>
                    <h2>Setor e atendimento</h2>
                    <p>Identidade e regras gerais deste número do WhatsApp.</p>
                  </div>
                  <span className="settings-scope-badge">Toda a sessão</span>
                  {settingsCardChevron('department')}
                </header>
                <div
                  id="settings-panel-department"
                  className="settings-panel-content"
                  hidden={!isSettingsCardExpanded('department')}
                >
                  <div className="settings-fields settings-fields-three">
                    <label>
                      <strong>Nome do setor</strong>
                      <small className="config-help">Identifica o setor vinculado a este número.</small>
                      <input
                        value={department.name}
                        onChange={e => setDepartment({ ...department, name: e.target.value })}
                      />
                    </label>
                    <label>
                      <strong>Fuso horário</strong>
                      <small className="config-help">Usado nos prazos e nos lembretes das 8h.</small>
                      <input
                        value={department.timezone}
                        onChange={e => setDepartment({ ...department, timezone: e.target.value })}
                      />
                    </label>
                    <label>
                      <strong>Expiração do menu</strong>
                      <small className="config-help">Encerra somente a conversa; preserva o cadastro.</small>
                      <span className="settings-input-unit">
                        <input
                          type="number"
                          min="1"
                          value={department.menuTimeoutMinutes}
                          onChange={e => setDepartment({ ...department, menuTimeoutMinutes: Number(e.target.value) })}
                        />
                        minutos
                      </span>
                    </label>
                    <label className="settings-field-full">
                      <strong>Horários de atendimento e exceções</strong>
                      <small className="config-help">
                        JSON da agenda semanal. “weekdays” define os dias e “exceptions” define feriados ou períodos
                        especiais.
                      </small>
                      <textarea rows={7} value={scheduleJson} onChange={e => setScheduleJson(e.target.value)} />
                    </label>
                  </div>
                  <footer className="settings-panel-actions">
                    <button
                      className="btn-secondary"
                      onClick={() => void saveDepartmentSettings()}
                      disabled={savingSettingsCard === 'department'}
                    >
                      <Save size={16} />{' '}
                      {savingSettingsCard === 'department' ? 'Salvando...' : 'Salvar setor e horários'}
                    </button>
                  </footer>
                </div>
              </article>
            )}

            {department && (
              <article
                className={`settings-panel settings-panel-wide ${isSettingsCardExpanded('candidate-columns') ? 'is-expanded' : 'is-collapsed'}`}
              >
                <header className="settings-panel-header" {...settingsCardHeaderProps('candidate-columns')}>
                  <div className="settings-panel-icon">
                    <Settings2 size={20} />
                  </div>
                  <div>
                    <h2>Campos padrão da tabela</h2>
                    <p>
                      Escolha as colunas exibidas em Cadastros e organize a ordem. Perguntas novas são adicionadas
                      automaticamente e aparecem por padrão.
                    </p>
                  </div>
                  <div className="candidate-column-save-status" aria-live="polite">
                    <span className="settings-scope-badge">Toda a sessão</span>
                    <small className={candidateColumnSaveState}>
                      {candidateColumnSaveState === 'saving'
                        ? 'Salvando no banco...'
                        : candidateColumnSaveState === 'saved'
                          ? 'Salvo no banco'
                          : candidateColumnSaveState === 'error'
                            ? 'Erro ao salvar'
                            : 'Salvamento automático'}
                    </small>
                  </div>
                  {settingsCardChevron('candidate-columns')}
                </header>
                <div
                  id="settings-panel-candidate-columns"
                  className="settings-panel-content"
                  hidden={!isSettingsCardExpanded('candidate-columns')}
                >
                  <div className="candidate-column-settings" role="list" aria-label="Ordem dos campos da tabela">
                    {candidateColumnPreferences.map((preference, index) => {
                      const column = availableCandidateColumns.find(item => item.id === preference.id);
                      if (!column) return null;
                      const visibleCount = candidateColumnPreferences.filter(item => item.visible).length;
                      return (
                        <div
                          className={`candidate-column-setting${candidateColumnDrag?.sourceId === preference.id ? ' is-dragging' : ''}${candidateColumnDrag?.overId === preference.id && candidateColumnDrag.sourceId !== preference.id ? ' is-drop-target' : ''}`}
                          role="listitem"
                          key={preference.id}
                          draggable
                          onDragStart={event => {
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', preference.id);
                            setCandidateColumnDrag({ sourceId: preference.id, overId: preference.id });
                          }}
                          onDragEnter={() =>
                            setCandidateColumnDrag(current =>
                              current ? { ...current, overId: preference.id } : current,
                            )
                          }
                          onDragOver={event => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                          }}
                          onDrop={event => {
                            event.preventDefault();
                            dropCandidateColumn(preference.id);
                          }}
                          onDragEnd={() => setCandidateColumnDrag(null)}
                        >
                          <GripVertical className="candidate-column-drag-handle" size={18} aria-hidden="true" />
                          <label>
                            <input
                              type="checkbox"
                              checked={preference.visible}
                              disabled={preference.visible && visibleCount === 1}
                              onChange={event =>
                                updateCandidateColumnPreferences(
                                  candidateColumnPreferences.map(item =>
                                    item.id === preference.id ? { ...item, visible: event.target.checked } : item,
                                  ),
                                )
                              }
                            />
                            <span>
                              <strong>{column.label}</strong>
                              <small>
                                {column.kind === 'fixed' ? 'Coluna do sistema' : 'Resposta de uma pergunta'}
                              </small>
                            </span>
                          </label>
                          <div className="candidate-column-order-actions">
                            <button
                              type="button"
                              className="icon-button"
                              disabled={index === 0}
                              onClick={() => moveCandidateColumn(index, -1)}
                              aria-label={`Subir ${column.label}`}
                              title="Subir coluna"
                            >
                              <ArrowUp size={16} />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              disabled={index === candidateColumnPreferences.length - 1}
                              onClick={() => moveCandidateColumn(index, 1)}
                              aria-label={`Descer ${column.label}`}
                              title="Descer coluna"
                            >
                              <ArrowDown size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <footer className="settings-panel-actions">
                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={saveCandidateColumns}
                      disabled={candidateColumnSaveState === 'saving'}
                    >
                      <Save size={16} />
                      {candidateColumnSaveState === 'saving' ? 'Salvando...' : 'Salvar campos da tabela'}
                    </button>
                  </footer>
                </div>
              </article>
            )}

            <article
              className={`settings-panel settings-panel-wide ${isSettingsCardExpanded('proximity-test') ? 'is-expanded' : 'is-collapsed'}`}
            >
              <header className="settings-panel-header" {...settingsCardHeaderProps('proximity-test')}>
                <div className="settings-panel-icon">
                  <Search size={20} />
                </div>
                <div>
                  <h2>Teste de localização</h2>
                  <p>Diagnostique o endereço de origem, o OpenStreetMap e as rotas até os locais de entrevista.</p>
                </div>
                <span className="settings-scope-badge">Toda a sessão</span>
                {settingsCardChevron('proximity-test')}
              </header>
              <div
                id="settings-panel-proximity-test"
                className="settings-panel-content"
                hidden={!isSettingsCardExpanded('proximity-test')}
              >
                <ProximityTestPanel sessionId={sessionId} />
              </div>
            </article>

            <article
              className={`settings-panel settings-panel-wide ${isSettingsCardExpanded('timeouts') ? 'is-expanded' : 'is-collapsed'}`}
            >
              <header className="settings-panel-header" {...settingsCardHeaderProps('timeouts')}>
                <div className="settings-panel-icon">
                  <TimerReset size={20} />
                </div>
                <div>
                  <h2>Prazos e limites</h2>
                  <p>Controle de expiração, atendimento e tentativas inválidas.</p>
                </div>
                {settingsCardChevron('timeouts')}
              </header>
              <div
                id="settings-panel-timeouts"
                className="settings-panel-content"
                hidden={!isSettingsCardExpanded('timeouts')}
              >
                <div className="talent-timeouts">
                  {(
                    [
                      ['flowTimeoutMinutes', 'Cadastro e atualização', 'minutos'],
                      ['humanInactivityMinutes', 'Inatividade humana', 'minutos'],
                      ['humanGraceMinutes', 'Prazo depois do aviso', 'minutos'],
                      ['validityMonths', 'Validade do cadastro', 'meses'],
                      ['invalidAttemptLimit', 'Tentativas inválidas', 'tentativas'],
                    ] as const
                  ).map(([key, label, unit]) => (
                    <label key={key}>
                      <strong>{label}</strong>
                      <small className="config-help">
                        {
                          {
                            flowTimeoutMinutes:
                              'Prazo entre respostas; ao expirar, apaga somente os dados temporários.',
                            humanInactivityMinutes: 'Tempo sem atividade antes do aviso de encerramento humano.',
                            humanGraceMinutes: 'Tempo adicional após o aviso antes do encerramento.',
                            validityMonths: 'Período antes de o cadastro exigir uma nova revisão.',
                            invalidAttemptLimit: 'Respostas inválidas permitidas antes de encerrar o fluxo.',
                          }[key]
                        }
                      </small>
                      <span className="settings-input-unit">
                        <input
                          type="number"
                          min="1"
                          value={String(flowConfig[key] ?? 1)}
                          onChange={e => setFlowConfig({ ...flowConfig, [key]: Number(e.target.value) })}
                        />
                        {unit}
                      </span>
                    </label>
                  ))}
                </div>
                <footer className="settings-panel-actions">
                  <button
                    className="btn-secondary"
                    type="button"
                    disabled={savingSettingsCard === 'timeouts'}
                    onClick={() =>
                      void saveFlowSettingsCard(
                        'timeouts',
                        {
                          flowTimeoutMinutes: flowConfig.flowTimeoutMinutes,
                          humanInactivityMinutes: flowConfig.humanInactivityMinutes,
                          humanGraceMinutes: flowConfig.humanGraceMinutes,
                          validityMonths: flowConfig.validityMonths,
                          invalidAttemptLimit: flowConfig.invalidAttemptLimit,
                        },
                        [
                          'flowTimeoutMinutes',
                          'humanInactivityMinutes',
                          'humanGraceMinutes',
                          'validityMonths',
                          'invalidAttemptLimit',
                        ],
                        'Prazos e limites salvos',
                      )
                    }
                  >
                    <Save size={16} /> {savingSettingsCard === 'timeouts' ? 'Salvando...' : 'Salvar prazos e limites'}
                  </button>
                </footer>
              </div>
            </article>

            <article className={`settings-panel ${isSettingsCardExpanded('pdf') ? 'is-expanded' : 'is-collapsed'}`}>
              <header className="settings-panel-header" {...settingsCardHeaderProps('pdf')}>
                <div className="settings-panel-icon">
                  <FileText size={20} />
                </div>
                <div>
                  <h2>Arquivos PDF</h2>
                  <p>Limite aplicado a cada PDF enviado neste fluxo.</p>
                </div>
                {settingsCardChevron('pdf')}
              </header>
              <div id="settings-panel-pdf" className="settings-panel-content" hidden={!isSettingsCardExpanded('pdf')}>
                <label className="settings-single-field">
                  <strong>Tamanho máximo</strong>
                  <span className="settings-input-unit">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={Math.round(Number(flowConfig.pdfMaxBytes ?? 10_485_760) / 1_048_576)}
                      onChange={e => setFlowConfig({ ...flowConfig, pdfMaxBytes: Number(e.target.value) * 1_048_576 })}
                    />
                    MB
                  </span>
                </label>
                <footer className="settings-panel-actions">
                  <button
                    className="btn-secondary"
                    type="button"
                    disabled={savingSettingsCard === 'pdf'}
                    onClick={() =>
                      void saveFlowSettingsCard(
                        'pdf',
                        { pdfMaxBytes: flowConfig.pdfMaxBytes },
                        ['pdfMaxBytes'],
                        'Limite de PDF salvo',
                      )
                    }
                  >
                    <Save size={16} /> {savingSettingsCard === 'pdf' ? 'Salvando...' : 'Salvar limite do PDF'}
                  </button>
                </footer>
              </div>
            </article>

            <article
              className={`settings-panel ${isSettingsCardExpanded('reminder') ? 'is-expanded' : 'is-collapsed'}`}
            >
              <header className="settings-panel-header" {...settingsCardHeaderProps('reminder')}>
                <div className="settings-panel-icon">
                  <CalendarDays size={20} />
                </div>
                <div>
                  <h2>Validade e lembrete</h2>
                  <p>Aviso enviado antes do vencimento do cadastro.</p>
                </div>
                {settingsCardChevron('reminder')}
              </header>
              <div
                id="settings-panel-reminder"
                className="settings-panel-content"
                hidden={!isSettingsCardExpanded('reminder')}
              >
                <label className="settings-single-field">
                  <strong>Antecedência</strong>
                  <small className="config-help">Deixe vazio para desativar o lembrete.</small>
                  <span className="settings-input-unit">
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={flowConfig.proactiveReminderDays ?? ''}
                      onChange={e =>
                        setFlowConfig({
                          ...flowConfig,
                          proactiveReminderDays: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                    dias
                  </span>
                </label>
                <footer className="settings-panel-actions">
                  <button
                    className="btn-secondary"
                    type="button"
                    disabled={savingSettingsCard === 'reminder'}
                    onClick={() =>
                      void saveFlowSettingsCard(
                        'reminder',
                        { proactiveReminderDays: flowConfig.proactiveReminderDays },
                        ['proactiveReminderDays'],
                        'Validade e lembrete salvos',
                      )
                    }
                  >
                    <Save size={16} />{' '}
                    {savingSettingsCard === 'reminder' ? 'Salvando...' : 'Salvar validade e lembrete'}
                  </button>
                </footer>
              </div>
            </article>
          </div>
        </section>
      )}

      <Modal
        open={runtimePendingAction !== null}
        title={
          runtimePendingAction === 'plugin'
            ? runtimeStatus?.status === 'enabled'
              ? 'Desativar a Central de Recrutamento?'
              : 'Ativar a Central de Recrutamento?'
            : sessionActive
              ? 'Desativar a sessão do WhatsApp?'
              : 'Ativar a sessão do WhatsApp?'
        }
        onClose={() => !runtimeActionSaving && setRuntimePendingAction(null)}
        closeLabel="Cancelar alteração de status"
        className="confirm-modal"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={runtimeActionSaving}
              onClick={() => setRuntimePendingAction(null)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className={
                (runtimePendingAction === 'plugin' && runtimeStatus?.status === 'enabled') ||
                (runtimePendingAction === 'session' && sessionActive)
                  ? 'btn-danger'
                  : 'btn-primary'
              }
              disabled={runtimeActionSaving}
              onClick={() => void confirmRuntimeStatusChange()}
            >
              {runtimeActionSaving ? 'Alterando…' : 'Confirmar alteração'}
            </button>
          </>
        }
      >
        <p>
          {runtimePendingAction === 'plugin'
            ? runtimeStatus?.status === 'enabled'
              ? 'O processamento automático da Central de Recrutamento será interrompido para todas as sessões até o plugin ser ativado novamente.'
              : 'O processamento automático da Central de Recrutamento será habilitado novamente.'
            : sessionActive
              ? 'A conexão desta sessão com o WhatsApp será interrompida. Ela poderá ser iniciada novamente pelo mesmo indicador.'
              : 'O sistema tentará iniciar esta sessão. Caso a autenticação tenha expirado, poderá ser necessário conectá-la novamente na tela de Sessões.'}
        </p>
      </Modal>
      <Modal
        open={humanServiceTargetEnabled !== null}
        title={humanServiceTargetEnabled ? 'Ativar atendimento humano?' : 'Encerrar atendimento humano?'}
        onClose={() => !humanServiceSaving && setHumanServiceTargetEnabled(null)}
        closeLabel="Cancelar alteração"
        className="confirm-modal"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={humanServiceSaving}
              onClick={() => setHumanServiceTargetEnabled(null)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className={humanServiceTargetEnabled ? 'btn-primary' : 'btn-danger'}
              disabled={humanServiceSaving}
              onClick={() => void confirmHumanServiceChange()}
            >
              {humanServiceSaving
                ? 'Salvando…'
                : humanServiceTargetEnabled
                  ? 'Ativar atendimento humano'
                  : 'Encerrar atendimento humano'}
            </button>
          </>
        }
      >
        <p>
          {humanServiceTargetEnabled
            ? 'A opção “Falar com atendimento humano” voltará aos menus dos fluxos que a possuem habilitada.'
            : `A opção “Falar com atendimento humano” será retirada dos menus e novas solicitações serão bloqueadas. ${activeTickets.length ? `Os ${activeTickets.length} chamado(s) aberto(s) continuarão ativos até serem encerrados manualmente.` : 'Não há chamados abertos.'}`}
        </p>
      </Modal>
      <Modal
        open={Boolean(outboxPendingAction)}
        title={outboxPendingAction?.action === 'retry' ? 'Tentar enviar novamente?' : 'Descartar mensagem não enviada?'}
        onClose={() => !outboxActionSaving && setOutboxPendingAction(null)}
        closeLabel="Cancelar ação"
        footer={
          <>
            <button
              className="btn-secondary"
              disabled={outboxActionSaving}
              onClick={() => setOutboxPendingAction(null)}
            >
              Voltar
            </button>
            <button
              className={outboxPendingAction?.action === 'discard' ? 'btn-danger' : 'btn-primary'}
              disabled={outboxActionSaving}
              onClick={async () => {
                if (!outboxPendingAction) return;
                setOutboxActionSaving(true);
                try {
                  if (outboxPendingAction.action === 'retry') {
                    await workflowHubApi.retryOutboxMessage(sessionId, outboxPendingAction.row.id);
                    toast.success('Mensagem reenfileirada com a mesma chave de idempotência.');
                  } else {
                    await workflowHubApi.discardOutboxMessage(sessionId, outboxPendingAction.row.id);
                    toast.success('Mensagem descartada. O registro técnico foi preservado.');
                  }
                  setOutboxPendingAction(null);
                  setOutboxHealth(await workflowHubApi.outboxHealth(sessionId));
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Não foi possível alterar o envio.');
                } finally {
                  setOutboxActionSaving(false);
                }
              }}
            >
              {outboxActionSaving
                ? 'Processando…'
                : outboxPendingAction?.action === 'retry'
                  ? 'Tentar agora'
                  : 'Descartar envio'}
            </button>
          </>
        }
      >
        <p>
          {outboxPendingAction?.action === 'retry'
            ? 'Antes de reenfileirar, o servidor verificará se a mensagem ainda corresponde ao estado atual. Se estiver obsoleta, ela será cancelada sem envio.'
            : 'A mensagem não será enviada. Ela ficará marcada como cancelada para auditoria e não poderá ser reenviada por engano.'}
        </p>
      </Modal>
      <Modal
        open={Boolean(pendingEditorNavigation)}
        title="Existem alterações não salvas"
        onClose={() => setPendingEditorNavigation(null)}
        closeLabel="Continuar editando"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setPendingEditorNavigation(null)}>
              Continuar editando
            </button>
            <button
              className="btn-danger"
              onClick={() => {
                if (!pendingEditorNavigation) return;
                if (pendingEditorNavigation.type === 'session') setSessionId(pendingEditorNavigation.id);
                else {
                  setSelectedFlowId(pendingEditorNavigation.id);
                  setExpandedFlowNodeId(null);
                }
                setPendingEditorNavigation(null);
              }}
            >
              Descartar e continuar
            </button>
          </>
        }
      >
        <p>
          Salve as perguntas, mensagens e configurações antes de trocar. Ao descartar, as alterações locais do fluxo
          serão perdidas.
        </p>
      </Modal>
      <Modal
        open={Boolean(selected)}
        onClose={() => {
          if (candidateSaving) return;
          setCandidateEditing(false);
          setSelected(null);
        }}
        title={selected ? candidateName(selected) : 'Dados do candidato'}
        closeLabel="Fechar dados do candidato"
        className="candidate-modal"
        footer={
          selected ? (
            <div className="candidate-modal-actions">
              <div>
                {isAdmin && !candidateEditing && (
                  <button
                    className="btn-danger"
                    onClick={() => {
                      setCandidatePendingDelete(selected);
                      setSelected(null);
                    }}
                  >
                    <Trash2 size={16} /> Excluir cadastro
                  </button>
                )}
              </div>
              <div>
                {candidateEditing ? (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={candidateSaving}
                      onClick={() => {
                        setCandidateEditData(selected.data);
                        setCandidateEditBaseline(selected.data);
                        setCandidateEditVersion(selected.currentVersion);
                        setCandidateEditing(false);
                      }}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={candidateSaving}
                      onClick={() => void saveCandidateData()}
                    >
                      <Save size={16} /> {candidateSaving ? 'Salvando...' : 'Salvar correções'}
                    </button>
                  </>
                ) : (
                  canWrite && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        setCandidateEditData(selected.data);
                        setCandidateEditBaseline(selected.data);
                        setCandidateEditVersion(selected.currentVersion);
                        setCandidateEditing(true);
                      }}
                    >
                      <Pencil size={16} /> Editar dados
                    </button>
                  )
                )}
              </div>
            </div>
          ) : undefined
        }
      >
        {selected && (
          <div className="candidate-modal-content">
            <div className="candidate-profile-summary">
              <div>
                <span>Contato</span>
                <strong>{candidateContact(selected)}</strong>
              </div>
              <div>
                <span>Números vinculados</span>
                <strong>
                  {[
                    ...new Set(
                      (selected.linkedContacts ?? []).map(contact =>
                        displayContactId(contact.contactId, contact.phone),
                      ),
                    ),
                  ]
                    .filter(number => number !== 'Número ainda não identificado')
                    .join(' · ') || candidateContact(selected)}
                </strong>
              </div>
              <div>
                <span>Fluxo</span>
                <strong>{selected.instanceName || 'Não informado'}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{selected.status}</strong>
              </div>
              <div>
                <span>Atualizado em</span>
                <strong>{new Date(selected.updatedAt).toLocaleString('pt-BR')}</strong>
              </div>
              <div>
                <span>Válido até</span>
                <strong>{new Date(selected.validUntil).toLocaleDateString('pt-BR')}</strong>
              </div>
            </div>
            <section className="candidate-linked-contacts" aria-labelledby="candidate-linked-contacts-title">
              <div className="candidate-linked-contacts-heading">
                <div>
                  <h3 id="candidate-linked-contacts-title">Números vinculados</h3>
                  <p>Edite os números ou escolha qual contato será usado como principal nesta ficha.</p>
                </div>
              </div>
              <div className="candidate-linked-contact-list">
                {(selected.linkedContacts ?? []).map(contact => (
                  <article className="candidate-linked-contact" key={contact.id}>
                    {candidateContactEditingId === contact.id ? (
                      <label>
                        <span>Telefone internacional</span>
                        <input
                          inputMode="numeric"
                          maxLength={15}
                          value={candidateContactPhone}
                          onChange={event => setCandidateContactPhone(event.target.value.replace(/\D/g, ''))}
                          aria-label="DDI, DDD e número"
                        />
                      </label>
                    ) : (
                      <div>
                        <strong>{displayContactId(contact.contactId, contact.phone)}</strong>
                        <small>{contact.isPrimary ? 'Número principal' : 'Número adicional'}</small>
                      </div>
                    )}
                    {canWrite && (
                      <div className="talent-row-actions">
                        {candidateContactEditingId === contact.id ? (
                          <>
                            <button
                              type="button"
                              className="btn-secondary compact"
                              disabled={candidateContactSaving}
                              onClick={() => {
                                setCandidateContactEditingId(null);
                                setCandidateContactPhone('');
                              }}
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              className="btn-primary compact"
                              disabled={candidateContactSaving}
                              onClick={() => void saveCandidateContact()}
                            >
                              <Save size={15} /> Salvar
                            </button>
                          </>
                        ) : (
                          <>
                            {!contact.isPrimary && (
                              <button
                                type="button"
                                className="btn-secondary compact"
                                disabled={candidateContactSaving}
                                onClick={() => void makeCandidateContactPrimary(contact.id)}
                                title="Definir como número principal"
                              >
                                <Star size={15} /> Tornar principal
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-secondary compact"
                              disabled={candidateContactSaving}
                              onClick={() => {
                                setCandidateContactEditingId(contact.id);
                                setCandidateContactPhone(contact.phone ?? contact.contactId.replace(/\D/g, ''));
                              }}
                            >
                              <Pencil size={15} /> Editar
                            </button>
                            <button
                              type="button"
                              className="icon-danger"
                              disabled={candidateContactSaving || contact.isPrimary}
                              onClick={() => setCandidateContactPendingDelete(contact)}
                              aria-label="Excluir número vinculado"
                              title={
                                contact.isPrimary
                                  ? 'Defina outro número como principal antes de excluir'
                                  : 'Excluir vínculo'
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="candidate-appointment-manager" aria-labelledby="candidate-appointment-title">
              <div className="candidate-appointment-heading">
                <div>
                  <h3 id="candidate-appointment-title">
                    <CalendarDays size={18} /> Entrevista
                  </h3>
                  <p>Consulte, marque ou reagende sem sair da ficha do candidato.</p>
                </div>
                {candidateCurrentAppointment?.slot && (
                  <span className="candidate-status" data-status="ENTREVISTA_MARCADA">
                    Entrevista confirmada
                  </span>
                )}
              </div>
              {candidateCurrentAppointment?.slot ? (
                <div className="candidate-current-appointment">
                  <div>
                    <span>Data e horário</span>
                    <strong>{new Date(candidateCurrentAppointment.slot.startsAt).toLocaleString('pt-BR')}</strong>
                  </div>
                  <div>
                    <span>Local</span>
                    <strong>{candidateCurrentAppointment.slot.location || 'Não informado'}</strong>
                  </div>
                  <div>
                    <span>Fase</span>
                    <strong>{interviewPhaseLabel(candidateCurrentAppointment.slot.interviewPhase)}</strong>
                  </div>
                  <div>
                    <span>Endereço</span>
                    <strong>{candidateCurrentAppointment.slot.address || 'Não informado'}</strong>
                  </div>
                  <div>
                    <span>Apresentar-se para</span>
                    <strong>{candidateCurrentAppointment.slot.responsible || 'Não informado'}</strong>
                  </div>
                </div>
              ) : (
                <p className="candidate-process-empty">Este candidato não possui entrevista futura confirmada.</p>
              )}
              {canWrite && (
                <div className="candidate-appointment-action">
                  <label>
                    <span>{candidateCurrentAppointment ? 'Novo horário' : 'Horário da entrevista'}</span>
                    <select
                      value={candidateAppointmentTargetSlotId}
                      onChange={event => setCandidateAppointmentTargetSlotId(event.target.value)}
                    >
                      <option value="">Selecione um horário disponível</option>
                      {candidateAvailableSlots.map(slot => (
                        <option key={slot.id} value={slot.id}>
                          {new Date(slot.startsAt).toLocaleString('pt-BR')}
                          {slot.location ? ` — ${slot.location}` : ''} — {interviewPhaseLabel(slot.interviewPhase)} (
                          {slot.capacity - slot.bookedCount} vaga(s))
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!candidateAppointmentTargetSlotId || candidateAppointmentSaving}
                    onClick={() => void saveCandidateAppointment()}
                  >
                    <CalendarDays size={16} />
                    {candidateAppointmentSaving
                      ? 'Salvando...'
                      : candidateCurrentAppointment
                        ? 'Reagendar entrevista'
                        : 'Marcar entrevista'}
                  </button>
                </div>
              )}
              {!candidateAvailableSlots.length && (
                <small className="candidate-appointment-empty">
                  Não há outro horário futuro com vaga neste fluxo. Cadastre um horário na aba Agenda.
                </small>
              )}
            </section>
            <section className="candidate-process-section" aria-labelledby="candidate-process-title">
              <h3 id="candidate-process-title">Processo seletivo</h3>
              {candidateRecruitmentLoading ? (
                <p className="candidate-process-empty">Carregando acompanhamento...</p>
              ) : candidateRecruitment ? (
                <>
                  <div className="candidate-profile-summary candidate-process-summary">
                    <div>
                      <span>Etapa atual</span>
                      <strong>
                        <span className="candidate-status" data-status={candidateRecruitment.status}>
                          {recruitmentStatusLabels[candidateRecruitment.status]}
                        </span>
                      </strong>
                    </div>
                    <div>
                      <span>Responsável pelo processo</span>
                      <strong>{candidateRecruitment.owner || 'Não definido'}</strong>
                    </div>
                    <div>
                      <span>Avaliação</span>
                      <strong>
                        {candidateRecruitment.rating ? `${candidateRecruitment.rating} de 5` : 'Não avaliado'}
                      </strong>
                    </div>
                    <div>
                      <span>Próxima ação</span>
                      <strong>
                        {candidateRecruitment.nextActionAt
                          ? new Date(candidateRecruitment.nextActionAt).toLocaleString('pt-BR')
                          : 'Não definida'}
                      </strong>
                    </div>
                    <div>
                      <span>Entrada no processo</span>
                      <strong>{new Date(candidateRecruitment.createdAt).toLocaleString('pt-BR')}</strong>
                    </div>
                    <div>
                      <span>Processo atualizado em</span>
                      <strong>{new Date(candidateRecruitment.updatedAt).toLocaleString('pt-BR')}</strong>
                    </div>
                  </div>
                  <div className="candidate-interview-details">
                    <h4>Entrevista vinculada</h4>
                    {candidateRecruitment.appointment ? (
                      <dl className="candidate-data-list">
                        <div>
                          <dt>Fase da entrevista</dt>
                          <dd>
                            {interviewPhaseLabel(
                              recruitmentCurrentInterviewPhase(candidateRecruitment.status) ??
                                candidateRecruitment.appointment.slot?.interviewPhase,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Status do agendamento</dt>
                          <dd>{candidateRecruitment.appointment.status}</dd>
                        </div>
                        <div>
                          <dt>Data e horário</dt>
                          <dd>
                            {candidateRecruitment.appointment.slot
                              ? new Date(candidateRecruitment.appointment.slot.startsAt).toLocaleString('pt-BR')
                              : 'Horário indisponível'}
                          </dd>
                        </div>
                        <div>
                          <dt>Local</dt>
                          <dd>
                            {candidateRecruitment.appointment.slot?.mapsUrl ? (
                              <a href={candidateRecruitment.appointment.slot.mapsUrl} target="_blank" rel="noreferrer">
                                {candidateRecruitment.appointment.slot.location || 'Abrir no Google Maps'}
                              </a>
                            ) : (
                              candidateRecruitment.appointment.slot?.location || 'Não informado'
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Endereço</dt>
                          <dd>{candidateRecruitment.appointment.slot?.address || 'Não informado'}</dd>
                        </div>
                        <div>
                          <dt>Instrução</dt>
                          <dd>{candidateRecruitment.appointment.slot?.instruction || 'Não informada'}</dd>
                        </div>
                        <div>
                          <dt>Apresentar-se para</dt>
                          <dd>{candidateRecruitment.appointment.slot?.responsible || 'Não informado'}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="candidate-process-empty">Nenhuma entrevista está vinculada a este processo.</p>
                    )}
                  </div>
                  <div className="recruitment-history candidate-process-history">
                    <h4>Histórico do processo</h4>
                    {candidateRecruitmentEvents.map(event => (
                      <div key={event.id}>
                        <strong>{recruitmentEventTitle(event)}</strong>
                        <span>Registrado em {new Date(event.createdAt).toLocaleString('pt-BR')}</span>
                        {recruitmentEventAppointmentDetail(event) && <p>{recruitmentEventAppointmentDetail(event)}</p>}
                        {event.note && <p>{event.note}</p>}
                      </div>
                    ))}
                    {!candidateRecruitmentEvents.length && <p>Nenhum evento registrado.</p>}
                  </div>
                </>
              ) : (
                <p className="candidate-process-empty">
                  Este candidato ainda não entrou no acompanhamento pós-entrevista.
                </p>
              )}
            </section>
            <section className="candidate-proximity-section" aria-labelledby="candidate-proximity-title">
              <div className="candidate-proximity-header">
                <div>
                  <h3 id="candidate-proximity-title">Locais de entrevista por proximidade</h3>
                  <p>Atualiza automaticamente ao alterar o endereço. Use a pesquisa manual para consultar novamente.</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void recalculateCandidateProximity()}
                  disabled={recalculatingProximity}
                >
                  <RefreshCw size={16} /> {recalculatingProximity ? 'Pesquisando...' : 'Pesquisar endereço novamente'}
                </button>
              </div>
              {selected.proximityStatus === 'CONCLUIDO' && selected.proximityData?.results.length ? (
                <div className="candidate-proximity-results">
                  {selected.proximityData.results.map(result => (
                    <article key={result.locationId} className={result.posicao === 1 ? 'is-recommended' : ''}>
                      <span className="candidate-proximity-position">{result.posicao}º</span>
                      <div>
                        <strong>{result.nome}</strong>
                        <small>{result.endereco}</small>
                      </div>
                      <div className="candidate-proximity-metrics">
                        {result.routeAvailable ? (
                          <>
                            <strong>{result.distanciaKm} km</strong>
                            <small>{formatDurationMinutes(result.tempoMinutos)}</small>
                          </>
                        ) : (
                          <small>Rota indisponível</small>
                        )}
                      </div>
                    </article>
                  ))}
                  {selected.proximityData.calculatedAt && (
                    <small>Calculado em {new Date(selected.proximityData.calculatedAt).toLocaleString('pt-BR')}.</small>
                  )}
                </div>
              ) : selected.proximityStatus === 'PENDENTE' || selected.proximityStatus === 'PROCESSANDO' ? (
                <p className="candidate-process-empty">
                  Pesquisa em segundo plano. Você pode fechar esta ficha; o resultado aparecerá automaticamente quando
                  terminar.
                </p>
              ) : selected.proximityData?.errorCode === 'INCOMPLETE_ORIGIN' ? (
                <p className="candidate-process-empty">
                  Preencha CEP, logradouro, número, bairro, cidade e estado no cadastro para calcular.
                </p>
              ) : selected.proximityData?.errorCode === 'NO_GEOREFERENCED_LOCATIONS' ? (
                <p className="candidate-process-empty">
                  Cadastre latitude e longitude nos locais de entrevista para habilitar a comparação.
                </p>
              ) : selected.proximityData?.errorCode === 'ADDRESS_NOT_FOUND' ? (
                <p className="candidate-process-empty">
                  O endereço não foi localizado. Revise logradouro, número, bairro, cidade, UF e CEP e salve novamente.
                </p>
              ) : selected.proximityData?.errorCode === 'GEOCODING_UNAVAILABLE' ? (
                <p className="candidate-process-empty">
                  O serviço de localização não respondeu após as tentativas automáticas. Use “Pesquisar endereço
                  novamente” em alguns minutos.
                </p>
              ) : selected.proximityData?.errorCode === 'ROUTING_UNAVAILABLE' ? (
                <p className="candidate-process-empty">
                  A localização foi consultada, mas o serviço de rotas está indisponível. Tente novamente em alguns
                  minutos.
                </p>
              ) : selected.proximityStatus === 'FALHA' ? (
                <p className="candidate-process-empty">
                  Não foi possível concluir a pesquisa de proximidade. Use “Pesquisar endereço novamente”.
                </p>
              ) : (
                <p className="candidate-process-empty">A proximidade ainda não foi calculada.</p>
              )}
            </section>
            <section className="candidate-answers-section" aria-labelledby="candidate-answers-title">
              <div className="candidate-answers-heading">
                <div>
                  <h3 id="candidate-answers-title">
                    <FileText size={18} /> Dados e respostas do cadastro
                  </h3>
                  <p>Os campos seguem a configuração atual do fluxo, inclusive para cadastros antigos.</p>
                </div>
                {!candidateEditing && canWrite && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setCandidateEditData(selected.data);
                      setCandidateEditBaseline(selected.data);
                      setCandidateEditVersion(selected.currentVersion);
                      setCandidateEditing(true);
                    }}
                  >
                    <Pencil size={16} /> Editar
                  </button>
                )}
              </div>
              <dl className="candidate-data-list">
                {selectedCandidateFields.map(field => {
                  const key = field.answerKey ?? field.id;
                  const value = candidateEditing ? candidateEditData[key] : selected.data[key];
                  return (
                    <div key={key} data-answer-key={key}>
                      <dt>
                        {field.label}
                        {field.required && <span className="candidate-required">Obrigatório</span>}
                      </dt>
                      <dd>
                        {candidateEditing ? renderCandidateEditor(field) : renderCandidateAnswer(selected, key, value)}
                      </dd>
                    </div>
                  );
                })}
                {selectedCandidateLegacyAnswers.map(([key, value]) => (
                  <div key={key} className="candidate-legacy-answer">
                    <dt>
                      {candidateFieldLabel(selected, key)} <span>Campo antigo</span>
                    </dt>
                    <dd>{renderCandidateAnswer(selected, key, value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {!isAdmin && (
              <p className="operator-permission-note">
                Operadores podem consultar os dados, mas somente administradores podem excluir um cadastro.
              </p>
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(candidateContactPendingDelete)}
        onClose={() => !candidateContactSaving && setCandidateContactPendingDelete(null)}
        title="Excluir número vinculado"
        className="confirm-modal"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={candidateContactSaving}
              onClick={() => setCandidateContactPendingDelete(null)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={candidateContactSaving}
              onClick={() => void deleteCandidateContact()}
            >
              <Trash2 size={16} /> {candidateContactSaving ? 'Excluindo...' : 'Excluir vínculo'}
            </button>
          </>
        }
      >
        <p>
          O número deixará de aparecer nesta identidade. O cadastro, as entrevistas e o histórico do candidato serão
          preservados.
        </p>
      </Modal>

      <Modal
        open={Boolean(candidatePendingDelete)}
        onClose={() => {
          setSelected(candidatePendingDelete);
          setCandidatePendingDelete(null);
        }}
        title="Confirmar exclusão"
        closeLabel="Cancelar exclusão"
        className="confirm-modal"
        footer={
          candidatePendingDelete ? (
            <>
              <button
                className="btn-secondary"
                onClick={() => {
                  setSelected(candidatePendingDelete);
                  setCandidatePendingDelete(null);
                }}
              >
                Cancelar
              </button>
              <button
                className="btn-danger"
                onClick={async () => {
                  try {
                    await workflowHubApi.deleteRecord(sessionId, candidatePendingDelete.id);
                    setCandidatePendingDelete(null);
                    setSelected(null);
                    toast.success('Cadastro excluído. O candidato será avisado pelo WhatsApp.');
                    await load();
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Falha ao excluir o cadastro');
                  }
                }}
              >
                <Trash2 size={16} /> Excluir definitivamente
              </button>
            </>
          ) : undefined
        }
      >
        <p>
          O cadastro de <strong>{candidatePendingDelete ? candidateName(candidatePendingDelete) : ''}</strong>, suas
          respostas e seus vínculos serão apagados. Esta ação não pode ser desfeita.
        </p>
      </Modal>

      <Modal
        open={Boolean(appointmentPendingReschedule)}
        onClose={() => setAppointmentPendingReschedule(null)}
        title="Reagendar uma pessoa"
        closeLabel="Cancelar reagendamento individual"
        className="confirm-modal reschedule-modal"
        footer={
          appointmentPendingReschedule ? (
            <>
              <button className="btn-secondary" onClick={() => setAppointmentPendingReschedule(null)}>
                Cancelar
              </button>
              <button
                className="btn-primary"
                disabled={!appointmentTargetSlotId}
                onClick={async () => {
                  try {
                    await workflowHubApi.rescheduleAppointment(
                      sessionId,
                      selectedFlowId,
                      appointmentPendingReschedule.id,
                      appointmentTargetSlotId,
                    );
                    setAppointmentPendingReschedule(null);
                    setAppointmentTargetSlotId('');
                    toast.success('Pessoa reagendada. O aviso foi preparado para envio pelo WhatsApp.');
                    await Promise.all([load(), loadAgenda()]);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Falha ao reagendar a pessoa');
                  }
                }}
              >
                Confirmar e avisar
              </button>
            </>
          ) : undefined
        }
      >
        <div className="reschedule-form">
          <p>
            Selecione um horário com vaga para{' '}
            <strong>{appointmentPendingReschedule ? appointmentContact(appointmentPendingReschedule) : ''}</strong>.
          </p>
          <label>
            Novo horário
            <select value={appointmentTargetSlotId} onChange={event => setAppointmentTargetSlotId(event.target.value)}>
              <option value="">Escolha uma data e horário</option>
              {slots
                .filter(
                  slot =>
                    slot.id !== appointmentPendingReschedule?.slot?.id &&
                    slot.status === 'DISPONIVEL' &&
                    slot.bookedCount < slot.capacity &&
                    Date.parse(slot.startsAt) > Date.now(),
                )
                .map(slot => (
                  <option key={slot.id} value={slot.id}>
                    {new Date(slot.startsAt).toLocaleString('pt-BR')}
                    {slot.location ? ` — ${slot.location}` : ''} — {interviewPhaseLabel(slot.interviewPhase)} (
                    {slot.capacity - slot.bookedCount} vaga(s))
                  </option>
                ))}
            </select>
          </label>
          {!slots.some(
            slot =>
              slot.id !== appointmentPendingReschedule?.slot?.id &&
              slot.status === 'DISPONIVEL' &&
              slot.bookedCount < slot.capacity &&
              Date.parse(slot.startsAt) > Date.now(),
          ) && <p className="outbox-warning">Cadastre outro horário disponível antes de reagendar esta pessoa.</p>}
        </div>
      </Modal>

      <Modal
        open={Boolean(slotPendingEdit)}
        onClose={() => setSlotPendingEdit(null)}
        title="Editar horário"
        closeLabel="Cancelar edição do horário"
        className="confirm-modal reschedule-modal"
        footer={
          slotPendingEdit ? (
            <>
              <button className="btn-secondary" onClick={() => setSlotPendingEdit(null)}>
                Cancelar
              </button>
              <button
                className="btn-primary"
                disabled={editSlotCapacity < slotPendingEdit.capacity}
                onClick={async () => {
                  try {
                    await workflowHubApi.updateSlot(sessionId, selectedFlowId, slotPendingEdit.id, {
                      instruction: editSlotInstruction,
                      responsible: editSlotResponsible,
                      interviewPhase: editSlotInterviewPhase,
                      capacity: editSlotCapacity,
                    });
                    setSlotPendingEdit(null);
                    toast.success('Horário atualizado');
                    await loadAgenda();
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Não foi possível atualizar o horário.');
                  }
                }}
              >
                <Save size={16} /> Salvar alterações
              </button>
            </>
          ) : undefined
        }
      >
        <div className="reschedule-form">
          <div className="reschedule-summary">
            <span>Reunião</span>
            <strong>
              {slotPendingEdit ? new Date(slotPendingEdit.startsAt).toLocaleString('pt-BR') : '—'}
              {slotPendingEdit?.location ? ` — ${slotPendingEdit.location}` : ''}
            </strong>
          </div>
          <label>
            Fase da entrevista
            <select
              value={editSlotInterviewPhase}
              onChange={event => setEditSlotInterviewPhase(event.target.value as WorkflowInterviewPhase)}
            >
              {interviewPhases.map(phase => (
                <option key={phase.value} value={phase.value}>
                  {phase.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Instrução
            <input
              maxLength={1000}
              value={editSlotInstruction}
              onChange={event => setEditSlotInstruction(event.target.value)}
            />
          </label>
          <label>
            Apresentar-se para
            <input
              maxLength={160}
              value={editSlotResponsible}
              onChange={event => setEditSlotResponsible(event.target.value)}
            />
          </label>
          <label>
            Limite de pessoas
            <input
              type="number"
              min={slotPendingEdit?.capacity ?? 1}
              max="1000"
              value={editSlotCapacity}
              onChange={event => setEditSlotCapacity(Math.max(1, Number(event.target.value) || 1))}
            />
            <small>O limite atual pode ser mantido ou aumentado sem afetar as pessoas já confirmadas.</small>
          </label>
        </div>
      </Modal>

      <Modal
        open={Boolean(slotPendingDelete)}
        onClose={() => setSlotPendingDelete(null)}
        title="Remover horário disponível"
        closeLabel="Cancelar remoção do horário"
        className="confirm-modal"
        footer={
          slotPendingDelete ? (
            <>
              <button className="btn-secondary" onClick={() => setSlotPendingDelete(null)}>
                Cancelar
              </button>
              <button
                className="btn-danger"
                onClick={async () => {
                  try {
                    await workflowHubApi.deleteSlot(sessionId, selectedFlowId, slotPendingDelete.id);
                    setSlotPendingDelete(null);
                    toast.success('Horário removido');
                    await Promise.all([load(), loadAgenda()]);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Falha ao remover o horário');
                  }
                }}
              >
                <Trash2 size={16} /> Remover horário
              </button>
            </>
          ) : undefined
        }
      >
        <p>
          Remover o horário de{' '}
          <strong>{slotPendingDelete ? new Date(slotPendingDelete.startsAt).toLocaleString('pt-BR') : ''}</strong> da
          lista disponível?
        </p>
      </Modal>

      <Modal
        open={Boolean(slotPendingReschedule)}
        onClose={() => setSlotPendingReschedule(null)}
        title="Reagendar candidatos e remover horário"
        closeLabel="Cancelar reagendamento"
        className="confirm-modal reschedule-modal"
        footer={
          slotPendingReschedule ? (
            <>
              <button className="btn-secondary" onClick={() => setSlotPendingReschedule(null)}>
                Cancelar
              </button>
              <button
                className="btn-primary"
                disabled={!rescheduleDate || rescheduleCapacity < slotPendingReschedule.bookedCount}
                onClick={async () => {
                  try {
                    if (new Date(rescheduleDate) <= new Date()) {
                      toast.error('Escolha uma nova data e um horário futuros.');
                      return;
                    }
                    const result = await workflowHubApi.rescheduleSlot(
                      sessionId,
                      selectedFlowId,
                      slotPendingReschedule.id,
                      {
                        startsAt: new Date(rescheduleDate).toISOString(),
                        locationId: rescheduleLocationId || undefined,
                        location: rescheduleLocation.trim() || undefined,
                        address: rescheduleAddress.trim() || undefined,
                        instruction: rescheduleInstruction.trim() || undefined,
                        responsible: rescheduleResponsible.trim() || undefined,
                        mapsUrl: rescheduleMapsUrl.trim() || undefined,
                        interviewPhase: rescheduleInterviewPhase,
                        capacity: rescheduleCapacity,
                      },
                    );
                    setSlotPendingReschedule(null);
                    toast.success(
                      `${result.movedAppointments} candidato(s) reagendado(s) e ${result.notified} aviso(s) preparado(s).`,
                    );
                    await Promise.all([load(), loadAgenda()]);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Falha ao reagendar os candidatos');
                  }
                }}
              >
                Confirmar nova data e avisar
              </button>
            </>
          ) : undefined
        }
      >
        <div className="reschedule-form">
          <p>
            Este horário possui <strong>{slotPendingReschedule?.bookedCount ?? 0} candidato(s)</strong>. Para removê-lo,
            informe a nova data. Todos serão transferidos e avisados automaticamente pelo WhatsApp.
          </p>
          <div className="reschedule-summary">
            <span>Horário atual</span>
            <strong>
              {slotPendingReschedule ? new Date(slotPendingReschedule.startsAt).toLocaleString('pt-BR') : '—'}
            </strong>
            <span>Novo horário</span>
            <strong>{rescheduleDate ? new Date(rescheduleDate).toLocaleString('pt-BR') : 'Escolha abaixo'}</strong>
          </div>
          <label>
            Nova data e horário
            <WorkflowDateTimePicker
              id="workflow-reschedule-date"
              ariaLabel="Nova data e horário da entrevista"
              value={rescheduleDate}
              onChange={setRescheduleDate}
            />
          </label>
          <label>
            Fase da entrevista
            <select
              value={rescheduleInterviewPhase}
              onChange={event => setRescheduleInterviewPhase(event.target.value as WorkflowInterviewPhase)}
            >
              {interviewPhases.map(phase => (
                <option key={phase.value} value={phase.value}>
                  {phase.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Local
            <select
              value={rescheduleLocationId}
              onChange={event => {
                const location = agendaLocations.find(item => item.id === event.target.value);
                setRescheduleLocationId(location?.id ?? '');
                setRescheduleLocation(location?.name ?? '');
                setRescheduleAddress(location?.address ?? '');
                setRescheduleMapsUrl(location?.mapsUrl ?? '');
              }}
            >
              <option value="">Selecione um local</option>
              {agendaLocations.map(location => (
                <option key={location.id} value={location.id}>
                  {location.internalName || location.name}
                  {location.internalName ? ` — ${location.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Endereço
            <input
              value={rescheduleAddress}
              readOnly
              aria-readonly="true"
              title="O endereço é definido no cadastro do local"
            />
          </label>
          <label>
            Instrução
            <input value={rescheduleInstruction} onChange={event => setRescheduleInstruction(event.target.value)} />
          </label>
          <label>
            Apresentar-se para
            <input value={rescheduleResponsible} onChange={event => setRescheduleResponsible(event.target.value)} />
          </label>
          <label>
            Limite de pessoas
            <input
              type="number"
              min={slotPendingReschedule?.bookedCount ?? 1}
              max="1000"
              value={rescheduleCapacity}
              onChange={event => setRescheduleCapacity(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={Boolean(deletionRequestPendingApprove)}
        onClose={() => setDeletionRequestPendingApprove(null)}
        title="Aprovar exclusão solicitada"
        closeLabel="Cancelar aprovação"
        className="confirm-modal"
        footer={
          deletionRequestPendingApprove ? (
            <>
              <button className="btn-secondary" onClick={() => setDeletionRequestPendingApprove(null)}>
                Cancelar
              </button>
              <button
                className="btn-danger"
                onClick={async () => {
                  try {
                    await workflowHubApi.decideDeletion(sessionId, deletionRequestPendingApprove.id, true);
                    setDeletionRequestPendingApprove(null);
                    toast.success('Exclusão aprovada e cadastro removido');
                    await load();
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Falha ao aprovar a exclusão');
                  }
                }}
              >
                <Trash2 size={16} /> Aprovar e excluir
              </button>
            </>
          ) : undefined
        }
      >
        <p>Todos os dados deste cadastro serão apagados definitivamente. Esta ação não pode ser desfeita.</p>
      </Modal>
    </div>
  );
}
