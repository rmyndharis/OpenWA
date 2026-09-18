import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  addGroupIds,
  filterGroupsByName,
  groupLabel,
  toggleGroupId,
  type SelectableGroup,
} from '../utils/groupSelection';

interface GroupPickerProps {
  groups: SelectableGroup[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading: boolean;
  labelledBy: string;
}

export function GroupPicker({ groups, selectedIds, onChange, loading, labelledBy }: GroupPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const visibleGroups = useMemo(() => filterGroupsByName(groups, query), [groups, query]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const noGroups = !loading && groups.length === 0;

  return (
    <div className="group-picker">
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('common.search')}
        aria-label={t('common.search')}
        disabled={loading || noGroups}
      />
      <div className="group-picker-toolbar">
        <button
          type="button"
          className="browse-btn"
          onClick={() =>
            onChange(
              addGroupIds(
                selectedIds,
                visibleGroups.map(group => group.id),
              ),
            )
          }
          disabled={loading || visibleGroups.length === 0}
        >
          {t('messageTester.selectAllGroups')}
        </button>
        <button type="button" className="browse-btn" onClick={() => onChange([])} disabled={selectedIds.length === 0}>
          {t('messageTester.clearGroupSelection')}
        </button>
        <span className="group-picker-count" role="status">
          {t('messageTester.groupsSelectedCount', { count: selectedIds.length })}
        </span>
      </div>
      <div className="group-picker-list" role="group" aria-labelledby={labelledBy}>
        {loading ? (
          <div className="group-picker-empty">
            <Loader2 className="animate-spin" size={16} />
            {t('messageTester.loadingGroups')}
          </div>
        ) : noGroups ? (
          <div className="group-picker-empty">{t('messageTester.noGroupsFound')}</div>
        ) : visibleGroups.length === 0 ? (
          <div className="group-picker-empty">{t('messageTester.noGroupsMatch')}</div>
        ) : (
          visibleGroups.map(group => (
            <label key={group.id} className="checkbox-label group-picker-option">
              <input
                type="checkbox"
                checked={selected.has(group.id)}
                onChange={() => onChange(toggleGroupId(selectedIds, group.id))}
              />
              <span title={groupLabel(group)}>{groupLabel(group)}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
