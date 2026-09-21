import type {
  WorkflowField,
  WorkflowGraphDefinition,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowSlot,
} from '../services/api.ts';
import { inspectWorkflowGraph } from './workflowGraph.ts';

export interface WorkflowSimulationMessage {
  id: number;
  side: 'bot' | 'user' | 'system';
  text: string;
}

export interface WorkflowSimulationState {
  cursor: string;
  currentFieldId?: string;
  answers: Record<string, unknown>;
  messages: WorkflowSimulationMessage[];
  complete: boolean;
  error?: string;
  sequence: number;
}

export function scrollWorkflowSimulatorToLatest(element: { scrollTop: number; scrollHeight: number } | null): void {
  if (element) element.scrollTop = element.scrollHeight;
}

const answerKey = (field: WorkflowField) => field.answerKey?.trim() || field.id;
const text = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));

function matches(condition: NonNullable<WorkflowGraphEdge['condition']>, value: unknown): boolean {
  if (condition.operator === 'filled')
    return value !== undefined && value !== null && value !== '' && value !== '__OPENWA_SKIPPED__';
  const left = text(value).toLocaleLowerCase('pt-BR');
  const right = text(condition.value).toLocaleLowerCase('pt-BR');
  if (condition.operator === 'contains')
    return Array.isArray(value)
      ? value.some(item => text(item).toLocaleLowerCase('pt-BR') === right)
      : left.includes(right);
  return condition.operator === 'notEquals' ? left !== right : left === right;
}

function visible(field: WorkflowField, answers: Record<string, unknown>, fields: WorkflowField[]): boolean {
  if (!field.visibleWhen) return true;
  const source = fields.find(item => item.id === field.visibleWhen?.fieldId);
  return matches(field.visibleWhen, answers[source ? answerKey(source) : field.visibleWhen.fieldId]);
}

function availableAppointmentSlots(slots: WorkflowSlot[]): WorkflowSlot[] {
  const now = Date.now();
  return slots.filter(
    slot => slot.status === 'DISPONIVEL' && slot.bookedCount < slot.capacity && Date.parse(slot.startsAt) > now,
  );
}

function appointmentLabel(slot: WorkflowSlot): string {
  const date = new Date(slot.startsAt).toLocaleString('pt-BR');
  return `${date}${slot.location ? ` — ${slot.location}` : ''}`;
}

function normalize(field: WorkflowField, raw: string, slots: WorkflowSlot[]): { value?: unknown; error?: string } {
  const value = raw.trim();
  if (!value) return { error: 'Digite uma resposta para continuar.' };
  if (/^pular$/i.test(value))
    return field.required
      ? { error: 'Esta pergunta é obrigatória e não pode ser pulada.' }
      : { value: '__OPENWA_SKIPPED__' };
  if (field.type === 'appointment') {
    const available = availableAppointmentSlots(slots);
    const index = Number(value) - 1;
    const selected = Number.isInteger(index) && index >= 0 ? available[index] : undefined;
    return selected ? { value: selected.id } : { error: 'Escolha o número de um horário disponível.' };
  }
  if (field.type === 'consent') {
    if (/^(sim|s|1)$/i.test(value)) return { value: true };
    if (/^(não|nao|n|2)$/i.test(value)) return { value: false };
    return { error: 'Use SIM ou NÃO nesta resposta.' };
  }
  if (field.type === 'select' && field.options?.length) {
    const index = Number(value) - 1;
    const selected =
      Number.isInteger(index) && index >= 0
        ? field.options[index]
        : field.options.find(option => option.toLocaleLowerCase('pt-BR') === value.toLocaleLowerCase('pt-BR'));
    return selected ? { value: selected } : { error: 'Escolha uma das opções apresentadas.' };
  }
  if (field.type === 'multiselect' && field.options?.length) {
    const selected = value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const index = Number(item) - 1;
        return Number.isInteger(index) && index >= 0
          ? field.options![index]
          : field.options!.find(option => option.toLocaleLowerCase('pt-BR') === item.toLocaleLowerCase('pt-BR'));
      });
    return selected.length && selected.every(Boolean)
      ? { value: selected }
      : { error: 'Use as opções ou seus números, separados por vírgula.' };
  }
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return { error: 'Informe um e-mail válido.' };
  if ((field.type === 'number' || field.type === 'currency') && !Number.isFinite(Number(value.replace(',', '.'))))
    return { error: 'Informe um número válido.' };
  if (field.min != null && value.length < field.min) return { error: `Use pelo menos ${field.min} caracteres.` };
  if (field.max != null && value.length > field.max) return { error: `Use no máximo ${field.max} caracteres.` };
  return { value: field.type === 'number' || field.type === 'currency' ? Number(value.replace(',', '.')) : value };
}

function append(state: WorkflowSimulationState, side: WorkflowSimulationMessage['side'], message: string): void {
  state.sequence += 1;
  state.messages.push({ id: state.sequence, side, text: message });
}

function nextNode(
  graph: WorkflowGraphDefinition,
  source: WorkflowGraphNode,
  answers: Record<string, unknown>,
  fields: WorkflowField[],
): WorkflowGraphNode | undefined {
  const field = source.data.fieldId ? fields.find(item => item.id === source.data.fieldId) : undefined;
  const value = field ? answers[answerKey(field)] : undefined;
  const outgoing = graph.edges.filter(edge => edge.source === source.id);
  const edge =
    outgoing.find(item => item.condition && matches(item.condition, value)) ?? outgoing.find(item => !item.condition);
  return edge ? graph.nodes.find(node => node.id === edge.target) : undefined;
}

function advance(
  state: WorkflowSimulationState,
  graph: WorkflowGraphDefinition,
  fields: WorkflowField[],
  slots: WorkflowSlot[],
): WorkflowSimulationState {
  const result: WorkflowSimulationState = {
    ...state,
    answers: { ...state.answers },
    messages: [...state.messages],
    currentFieldId: undefined,
    error: undefined,
  };
  let source = graph.nodes.find(node => node.id === result.cursor);
  for (let guard = 0; source && guard <= graph.nodes.length; guard += 1) {
    const next = nextNode(graph, source, result.answers, fields);
    if (!next) return { ...result, error: 'Este caminho não possui uma próxima etapa.' };
    result.cursor = next.id;
    if (next.type === 'review') {
      append(result, 'system', 'Fim do caminho: o sistema apresentará a revisão e confirmação dos dados.');
      result.complete = true;
      return result;
    }
    if (next.type === 'message') append(result, 'bot', next.data.text || '(mensagem vazia)');
    if (next.type === 'question') {
      const field = fields.find(item => item.id === next.data.fieldId);
      if (field && visible(field, result.answers, fields)) {
        result.currentFieldId = field.id;
        const choices =
          field.type === 'appointment' ? availableAppointmentSlots(slots).map(appointmentLabel) : (field.options ?? []);
        const choicesText = choices.length
          ? choices.map((option, index) => `${index + 1}. ${option}`).join('\n')
          : field.type === 'appointment'
            ? 'Nenhum horário disponível no momento.'
            : '';
        const hasChoicesMarker = /\{(?:opções|opcoes)\}/i.test(field.prompt);
        const prompt = hasChoicesMarker
          ? field.prompt.replace(/\{(?:opções|opcoes)\}/gi, choicesText)
          : `${field.prompt}${choicesText ? `\n${choicesText}` : ''}`;
        append(result, 'bot', `${prompt}${field.required ? '' : '\nDigite PULAR para não responder.'}`);
        return result;
      }
    }
    source = next;
  }
  return { ...result, error: 'O simulador interrompeu um caminho que excedeu o limite de segurança.' };
}

export function startWorkflowSimulation(
  graph: WorkflowGraphDefinition,
  fields: WorkflowField[],
  slots: WorkflowSlot[] = [],
): WorkflowSimulationState {
  const issue = inspectWorkflowGraph(graph)[0];
  if (issue)
    return { cursor: graph.startNodeId, answers: {}, messages: [], complete: false, error: issue.message, sequence: 0 };
  return advance(
    { cursor: graph.startNodeId, answers: {}, messages: [], complete: false, sequence: 0 },
    graph,
    fields,
    slots,
  );
}

export function answerWorkflowSimulation(
  state: WorkflowSimulationState,
  raw: string,
  graph: WorkflowGraphDefinition,
  fields: WorkflowField[],
  slots: WorkflowSlot[] = [],
): WorkflowSimulationState {
  if (state.complete || !state.currentFieldId) return state;
  const field = fields.find(item => item.id === state.currentFieldId);
  if (!field) return { ...state, error: 'A pergunta atual não existe mais.' };
  const parsed = normalize(field, raw, slots);
  const next: WorkflowSimulationState = {
    ...state,
    answers: { ...state.answers },
    messages: [...state.messages],
    error: parsed.error,
  };
  if (parsed.error) return next;
  append(next, 'user', raw.trim());
  next.answers[answerKey(field)] = parsed.value;
  next.currentFieldId = undefined;
  return advance(next, graph, fields, slots);
}
