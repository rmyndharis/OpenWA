export const DEFAULT_WORKFLOW_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  consent:
    '{contexto}Para iniciar “{fluxo}”, precisamos tratar suas respostas conforme a finalidade deste cadastro. Você concorda? Responda SIM ou NÃO.',
  updateConsent:
    'Antes de atualizar seus dados em “{fluxo}”, precisamos registrar um novo consentimento. Você concorda? Responda SIM ou NÃO.',
  review: 'Confira suas respostas:\n\n{resumo}\n\n1. Confirmar\n2. Corrigir\n3. Encerrar',
  completed: 'Dados confirmados e salvos.',
  existingCpfLinked:
    'Este CPF já possui cadastro. O novo número foi vinculado com sucesso e nenhum cadastro duplicado foi criado.\n\n{menu}',
  flowExpired:
    'O prazo expirou. As respostas temporárias foram apagadas. Envie uma nova mensagem para começar novamente.',
  humanStarted: 'Atendimento humano iniciado. O bot ficará em silêncio até o encerramento.',
  humanWarning: 'Seu atendimento está sem atividade e será encerrado em {minutos} minutos.',
  humanClosed: 'O atendimento foi encerrado. Envie uma nova mensagem para abrir o menu novamente.',
  conversationClosed: 'Atendimento encerrado. O menu só será exibido quando você enviar uma nova mensagem.',
  interviewScheduled: `✅ *Sua entrevista foi marcada com sucesso!*

{detalhes_agendamento}

Se precisar alterar, utilize a opção *Remarcar minha entrevista* no menu.`,
  interviewScheduledPhase2: `✅ *Você avançou para a 2ª fase!*

Sua *entrevista teste* foi marcada com sucesso.

{detalhes_agendamento}

Confira as informações e, se precisar alterar, utilize a opção *Remarcar minha entrevista* no menu.`,
  interviewScheduledPhase3: `🎉 *Você avançou para a 3ª fase!*

Sua *entrevista com o DP* foi marcada com sucesso.

{detalhes_agendamento}

Confira as informações e, se precisar alterar, utilize a opção *Remarcar minha entrevista* no menu.`,
  interviewReminder:
    '⏰ *Lembrete da sua entrevista*\nSua entrevista é *hoje, às {hora}*.\n\n{detalhes_agendamento}\n\nEsperamos por você! 😊',
  interviewCancelled:
    '❌ *Sua entrevista foi cancelada*\n\n{detalhes_agendamento}\n\nEnvie uma nova mensagem para consultar os próximos horários disponíveis.',
  interviewRescheduled:
    '✅ *Sua entrevista foi reagendada com sucesso!*\n\n🕐 Horário anterior:\n*{horario_anterior}*\n\n📅 *Novo horário:*\n{detalhes_agendamento}\n\nConfira as novas informações acima.\nSe precisar fazer outra alteração, utilize a opção *Remarcar minha entrevista* no menu.',
  privacyDeleted:
    'Seus dados pessoais foram excluídos conforme solicitado. Para utilizar o atendimento novamente, será necessário realizar um novo cadastro.',
  privacyAdminDeleted:
    'Seu cadastro e seus dados foram excluídos por um administrador. Para utilizar o atendimento novamente, será necessário realizar um novo cadastro.',
});

const LEGACY_WORKFLOW_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  interviewReminder: 'Lembrete: sua entrevista é hoje às {hora}{local}.',
  interviewCancelled:
    'Seu horário marcado para {data} às {hora} foi cancelado{local}. Envie uma nova mensagem para consultar os próximos horários disponíveis.',
  interviewRescheduled:
    'Seu horário foi reagendado. Horário anterior: {horario_anterior}. Novo horário: {novo_horario}{local}.',
});

export function completeWorkflowMessages(messages: Record<string, string> | null | undefined): Record<string, string> {
  const configured = Object.fromEntries(
    Object.entries(messages ?? {}).map(([key, value]) => [
      key,
      LEGACY_WORKFLOW_MESSAGES[key] === value ? DEFAULT_WORKFLOW_MESSAGES[key] : value,
    ]),
  );
  return { ...DEFAULT_WORKFLOW_MESSAGES, ...configured };
}

/** Places numbered choices at the administrator marker, or keeps the legacy appended layout. */
export function placeWorkflowQuestionChoices(prompt: string, choices: string): string {
  if (/\{(?:opções|opcoes)\}/i.test(prompt)) return prompt.replace(/\{(?:opções|opcoes)\}/gi, choices);
  return `${prompt}${choices ? `\n${choices}` : ''}`;
}
