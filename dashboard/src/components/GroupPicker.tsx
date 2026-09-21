import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  addGroupIds,
  filterGroupRows,
  groupPickerRows,
  toggleGroupId,
  type SelectableGroup,
} from '../utils/groupSelection';

interface GroupPickerProps {
  groups: SelectableGroup[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading: boolean;
  limit: number;
  labelledBy: string;
  disabled?: boolean;
}

export function GroupPicker({
  groups,
  selectedIds,
  onChange,
  loading,
  limit,
  labelledBy,
  disabled = false,
}: GroupPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => groupPickerRows(groups, selectedIds), [groups, selectedIds]);
  const visibleRows = useMemo(() => filterGroupRows(rows, query), [rows, query]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const atLimit = selectedIds.length >= limit;
  const noGroups = !loading && rows.length === 0;
  const filtering = query.trim() !== '';

  return (
    <div className="group-picker">
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('common.search')}
        aria-label={t('common.search')}
        disabled={disabled || loading || noGroups}
      />
      <div className="group-picker-toolbar">
        <button
          type="button"
          className="browse-btn"
          onClick={() =>
            onChange(
              addGroupIds(
                selectedIds,
                visibleRows.map(row => row.id),
                limit,
              ),
            )
          }
          disabled={disabled || loading || atLimit || visibleRows.length === 0}
        >
          {filtering ? t('messageTester.selectMatchingGroups') : t('messageTester.selectAllGroups')}
        </button>
        <button
          type="button"
          className="browse-btn"
          onClick={() => onChange([])}
          disabled={disabled || selectedIds.length === 0}
        >
          {t('messageTester.clearGroupSelection')}
        </button>
        <span className="group-picker-count" role="status">
          {t('messageTester.groupsSelectedCount', { count: selectedIds.length, max: limit })}
        </span>
      </div>
      <div className="group-picker-list">
        {loading ? (
          <p className="group-picker-empty">
            <Loader2 className="animate-spin" size={16} />
            {t('messageTester.loadingGroups')}
          </p>
        ) : noGroups ? (
          <p className="group-picker-empty">{t('messageTester.noGroupsFound')}</p>
        ) : visibleRows.length === 0 ? (
          <p className="group-picker-empty">{t('messageTester.noGroupsMatch')}</p>
        ) : (
          <ul aria-labelledby={labelledBy}>
            {visibleRows.map(row => {
              const checked = selected.has(row.id);
              return (
                <li key={row.id}>
                  <label className="checkbox-label group-picker-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || (!checked && atLimit)}
                      onChange={() => onChange(toggleGroupId(selectedIds, row.id))}
                    />
                    <span title={row.label}>{row.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
