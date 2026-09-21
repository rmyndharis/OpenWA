import type { WorkflowFieldDefinition } from './entities/workflow-hub.entity';

const answerKey = (field: WorkflowFieldDefinition): string => field.answerKey?.trim() || field.id;

const legacyAnswerAliases: Record<string, string[]> = {
  endereco_cep: ['cep'],
  endereco_logradouro: ['logradouro', 'rua'],
  endereco_numero: ['numero'],
  endereco_complemento: ['complemento'],
  endereco_bairro: ['bairro'],
  endereco_cidade: ['cidade'],
  endereco_estado: ['estado', 'uf', 'endereco_uf'],
};

/**
 * Migrates record JSON by stable field id when an administrator renames an answer key.
 * Keys removed from the current schema are discarded so obsolete/duplicate answers are
 * neither displayed nor retained indefinitely.
 */
export function reconcileWorkflowRecordData(
  data: Record<string, unknown>,
  previousFields: WorkflowFieldDefinition[],
  currentFields: WorkflowFieldDefinition[],
): { data: Record<string, unknown>; changed: boolean } {
  const next = { ...data };
  const currentById = new Map(currentFields.map(field => [field.id, field]));
  const currentKeys = new Set(currentFields.map(answerKey));

  // Address fields predate the stable field-id migration in some installations. Those records
  // may have no definitionVersionId, so map the known legacy keys by meaning as a safe fallback.
  for (const current of currentFields) {
    const newKey = answerKey(current);
    if (newKey in next) continue;
    const legacyKey = legacyAnswerAliases[newKey]?.find(key => key in next);
    if (!legacyKey) continue;
    next[newKey] = next[legacyKey];
    if (!currentKeys.has(legacyKey)) delete next[legacyKey];
  }

  for (const previous of previousFields) {
    const oldKey = answerKey(previous);
    const current = currentById.get(previous.id);
    if (!current) {
      if (!currentKeys.has(oldKey)) delete next[oldKey];
      continue;
    }
    const newKey = answerKey(current);
    if (oldKey === newKey || !(oldKey in next)) continue;
    if (!(newKey in next)) next[newKey] = next[oldKey];
    if (!currentKeys.has(oldKey)) delete next[oldKey];
  }

  return { data: next, changed: JSON.stringify(next) !== JSON.stringify(data) };
}
