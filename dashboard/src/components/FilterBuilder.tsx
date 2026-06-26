import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import {
  type Chat,
  type WebhookFilters,
  type WebhookFilterCondition,
  type WebhookFilterOperator,
} from '../services/api';
import './FilterBuilder.css';

type FieldKind = 'id' | 'idArray' | 'text' | 'enum' | 'boolean';

interface FieldDescriptor {
  field: string;
  kind: FieldKind;
  operators: WebhookFilterOperator[];
  enumValues?: string[];
}

const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'revoked',
  'unknown',
];

// Mirrors the backend message-family field registry (src/modules/webhook/filters/filter-types.ts).
const MESSAGE_FIELDS: FieldDescriptor[] = [
  { field: 'sender', kind: 'id', operators: ['is', 'isNot'] },
  { field: 'recipient', kind: 'id', operators: ['is', 'isNot'] },
  { field: 'body', kind: 'text', operators: ['contains', 'equals'] },
  { field: 'type', kind: 'enum', operators: ['is', 'isNot'], enumValues: MESSAGE_TYPES },
  { field: 'isGroup', kind: 'boolean', operators: ['is'] },
  { field: 'fromMe', kind: 'boolean', operators: ['is'] },
  { field: 'hasMedia', kind: 'boolean', operators: ['is'] },
  { field: 'mentions', kind: 'idArray', operators: ['is', 'isNot'] },
];

const descriptorFor = (field: string): FieldDescriptor =>
  MESSAGE_FIELDS.find(f => f.field === field) ?? MESSAGE_FIELDS[0];

function defaultValueFor(kind: FieldKind): WebhookFilterCondition['value'] {
  if (kind === 'boolean') return true;
  if (kind === 'text') return '';
  return [];
}

/** Accepts a full JID or a phone number; normalizes bare numbers to `<digits>@c.us`. */
function normalizeToJid(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('@')) return value.toLowerCase();
  const digits = value.replace(/[^0-9]/g, '');
  return digits ? `${digits}@c.us` : null;
}

interface ContactChipsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  chats: Chat[];
}

function ContactChipsInput({ value, onChange, chats }: ContactChipsInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    const query = text.trim().toLowerCase();
    const chosen = new Set(value);
    return chats
      .filter(c => !chosen.has(c.id))
      .filter(c => !query || c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
      .slice(0, 8);
  }, [text, chats, value]);

  const labelFor = (jid: string) => chats.find(c => c.id === jid)?.name ?? jid;
  const add = (jid: string) => {
    if (jid && !value.includes(jid)) onChange([...value, jid]);
    setText('');
  };
  const addTyped = () => {
    const jid = normalizeToJid(text);
    if (jid) add(jid);
  };

  return (
    <div className="chips-input">
      <div className="chips-row">
        {value.map(jid => (
          <span key={jid} className="chip" title={jid}>
            {labelFor(jid)}
            <button type="button" className="chip-remove" onClick={() => onChange(value.filter(v => v !== jid))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="chips-text"
          value={text}
          placeholder={t('webhooks.filters.contactPlaceholder')}
          onChange={e => setText(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTyped();
            } else if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
      </div>
      {open && (suggestions.length > 0 || text.trim()) && (
        <div className="chips-suggestions">
          {suggestions.map(c => (
            <button
              key={c.id}
              type="button"
              className="chips-suggestion"
              onMouseDown={e => e.preventDefault()}
              onClick={() => add(c.id)}
            >
              <span className="chips-suggestion-name">{c.name || c.id}</span>
              <span className="chips-suggestion-id">{c.id}</span>
            </button>
          ))}
          {text.trim() && normalizeToJid(text) && (
            <button
              type="button"
              className="chips-suggestion chips-suggestion-add"
              onMouseDown={e => e.preventDefault()}
              onClick={addTyped}
            >
              {t('webhooks.filters.addValue', { value: normalizeToJid(text) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface FilterBuilderProps {
  filters: WebhookFilters | null | undefined;
  onChange: (filters: WebhookFilters | null) => void;
  chats: Chat[];
}

export function FilterBuilder({ filters, onChange, chats }: FilterBuilderProps) {
  const { t } = useTranslation();
  const conditions = filters?.conditions ?? [];

  const emit = (next: WebhookFilterCondition[]) => onChange(next.length ? { conditions: next } : null);

  const updateAt = (index: number, patch: Partial<WebhookFilterCondition>) =>
    emit(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const addCondition = () => {
    const def = MESSAGE_FIELDS[0];
    emit([...conditions, { field: def.field, operator: def.operators[0], value: defaultValueFor(def.kind) }]);
  };

  const changeField = (index: number, field: string) => {
    const def = descriptorFor(field);
    updateAt(index, { field, operator: def.operators[0], value: defaultValueFor(def.kind), caseSensitive: undefined });
  };

  return (
    <div className="filter-builder">
      <div className="filter-builder-head">
        <span className="filter-builder-title">{t('webhooks.filters.title')}</span>
        <span className="filter-builder-hint">{t('webhooks.filters.hint')}</span>
      </div>

      {conditions.map((condition, index) => {
        const def = descriptorFor(condition.field);
        return (
          <div key={index} className="filter-row">
            <select className="filter-field" value={condition.field} onChange={e => changeField(index, e.target.value)}>
              {MESSAGE_FIELDS.map(f => (
                <option key={f.field} value={f.field}>
                  {t(`webhooks.filters.fields.${f.field}`)}
                </option>
              ))}
            </select>

            <select
              className="filter-operator"
              value={condition.operator}
              onChange={e => updateAt(index, { operator: e.target.value as WebhookFilterOperator })}
            >
              {def.operators.map(op => (
                <option key={op} value={op}>
                  {t(`webhooks.filters.operators.${op}`)}
                </option>
              ))}
            </select>

            <div className="filter-value">
              {(def.kind === 'id' || def.kind === 'idArray') && (
                <ContactChipsInput
                  value={Array.isArray(condition.value) ? (condition.value as string[]) : []}
                  onChange={next => updateAt(index, { value: next })}
                  chats={chats}
                />
              )}

              {def.kind === 'enum' && (
                <div className="filter-enum">
                  {def.enumValues?.map(option => {
                    const selected = Array.isArray(condition.value) && (condition.value as string[]).includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        className={`enum-tag ${selected ? 'selected' : ''}`}
                        onClick={() => {
                          const current = Array.isArray(condition.value) ? (condition.value as string[]) : [];
                          updateAt(index, {
                            value: selected ? current.filter(v => v !== option) : [...current, option],
                          });
                        }}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              )}

              {def.kind === 'text' && (
                <div className="filter-text">
                  <input
                    type="text"
                    value={typeof condition.value === 'string' ? condition.value : ''}
                    placeholder={t('webhooks.filters.textPlaceholder')}
                    onChange={e => updateAt(index, { value: e.target.value })}
                  />
                  <label className="filter-case">
                    <input
                      type="checkbox"
                      checked={condition.caseSensitive ?? false}
                      onChange={e => updateAt(index, { caseSensitive: e.target.checked || undefined })}
                    />
                    {t('webhooks.filters.caseSensitive')}
                  </label>
                </div>
              )}

              {def.kind === 'boolean' && (
                <select
                  className="filter-bool"
                  value={condition.value === true ? 'true' : 'false'}
                  onChange={e => updateAt(index, { value: e.target.value === 'true' })}
                >
                  <option value="true">{t('webhooks.filters.yes')}</option>
                  <option value="false">{t('webhooks.filters.no')}</option>
                </select>
              )}
            </div>

            <button
              type="button"
              className="filter-remove"
              title={t('webhooks.filters.removeCondition')}
              onClick={() => emit(conditions.filter((_, i) => i !== index))}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}

      <button type="button" className="filter-add" onClick={addCondition}>
        <Plus size={14} />
        {t('webhooks.filters.addCondition')}
      </button>
    </div>
  );
}
