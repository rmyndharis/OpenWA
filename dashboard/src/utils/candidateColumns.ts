export type CandidateColumnPreference = { id: string; visible: boolean };

type AvailableCandidateColumn = { id: string; kind: 'fixed' | 'answer' };

const DEFAULT_CANDIDATE_COLUMNS = new Set([
  'name',
  'contact',
  'status',
  'processStatus',
  'answer:email',
  'answer:e_mail',
  'answer:cidade',
  'answer:bairro',
  'answer:area_interesse',
  'answer:area_de_interesse',
]);

export function reconcileCandidateColumnPreferences(
  available: AvailableCandidateColumn[],
  configured?: CandidateColumnPreference[],
  legacyAliases: ReadonlyMap<string, string> = new Map(),
): CandidateColumnPreference[] {
  const availableById = new Map(available.map(column => [column.id, column]));
  const seen = new Set<string>();
  const reconciled: CandidateColumnPreference[] = [];

  for (const preference of configured ?? []) {
    const id = availableById.has(preference.id) ? preference.id : legacyAliases.get(preference.id);
    if (!id || !availableById.has(id) || seen.has(id)) continue;
    seen.add(id);
    reconciled.push({ id, visible: preference.visible !== false });
  }

  for (const column of available) {
    if (seen.has(column.id)) continue;
    reconciled.push({
      id: column.id,
      // Renames are reconciled above. Only a genuinely new question starts visible by default.
      visible: column.kind === 'answer' || DEFAULT_CANDIDATE_COLUMNS.has(column.id),
    });
  }

  if (reconciled.length && !reconciled.some(column => column.visible)) reconciled[0].visible = true;
  return reconciled;
}

export function reorderCandidateColumnPreferences(
  preferences: CandidateColumnPreference[],
  sourceId: string,
  targetId: string,
): CandidateColumnPreference[] {
  if (sourceId === targetId) return preferences;
  const sourceIndex = preferences.findIndex(preference => preference.id === sourceId);
  const targetIndex = preferences.findIndex(preference => preference.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return preferences;

  const next = [...preferences];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}
