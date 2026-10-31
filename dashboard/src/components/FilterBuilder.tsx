import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import {
  MESSAGE_TYPES,
  CHAT_KINDS,
  type Chat,
  type WebhookFilters,
  type WebhookFilterCondition,
  type WebhookFilterOperator,
} from '../services/api';
import { filterValueLabel } from '../utils/enumLabels';
import { normalizePhoneText } from '../utils/phone';
import { MAX_FILTER_CONDITIONS, MAX_FILTER_TEXT_LENGTH } from '../utils/webhookFilters';
import { isComposingKey } from '../utils/composition';
import './FilterBuilder.css';

type FieldKind = 'id' | 'idArray' | 'text' | 'enum' | 'boolean';

interface FieldDescriptor {
  field: string;
  kind: FieldKind;
  operators: WebhookFilterOperator[];
  enumValues?: readonly string[];
}

// Mirrors the backend message-family field registry (src/modules/webhook/filters/filter-types.ts).
const MESSAGE_FIELDS: FieldDescriptor[] = [
  { field: 'sender', kind: 'id', operators: ['is', 'isNot'] },
  { field: 'recipient', kind: 'id', operators: ['is', 'isNot'] },
  { field: 'chatId', kind: 'id', operators: ['is', 'isNot'] },
  { field: 'body', kind: 'text', operators: ['contains', 'equals'] },
  { field: 'type', kind: 'enum', operators: ['is', 'isNot'], enumValues: MESSAGE_TYPES },
  { field: 'isGroup', kind: 'boolean', operators: ['is'] },
  { field: 'kind', kind: 'enum', operators: ['is', 'isNot'], enumValues: CHAT_KINDS },
  { field: 'fromMe', kind: 'boolean', operators: ['is'] },
  { field: 'hasMedia', kind: 'boolean', operators: ['is'] },
  { field: 'mentions', kind: 'idArray', operators: ['is', 'isNot'] },
];

const descriptorFor = (field: string): FieldDescriptor =>
  MESSAGE_FIELDS.find(f => f.field === field) ?? MESSAGE_FIELDS[0];

// Rows are keyed by condition, not by index: with an index key, removing a row hands its unsent chip text
// to the row that moves into its place. An edited condition is a new object, so it inherits the old key.
const rowKeys = new WeakMap<WebhookFilterCondition, number>();
let nextRowKey = 0;
function rowKeyFor(condition: WebhookFilterCondition): number {
  let key = rowKeys.get(condition);
  if (key === undefined) rowKeys.set(condition, (key = nextRowKey++));
  return key;
}

function defaultValueFor(kind: FieldKind): WebhookFilterCondition['value'] {
  if (kind === 'boolean') return true;
  if (kind === 'text') return '';
  return [];
}

const PHONE_MAX_DIGITS = 15;
const phoneDigits = (value: string) => normalizePhoneText(value).replace(/[^0-9]/g, '');
// A typed number that cannot be added, so the field says why instead of ignoring Enter.
const isTooLong = (raw: string) => !raw.includes('@') && phoneDigits(raw).length > PHONE_MAX_DIGITS;

/**
 * Accepts a full JID or a phone number; normalizes bare numbers to `<digits>@c.us`. More than 15 digits (E.164) is no
 * phone number, such as two numbers typed with a space between them, so it is not added.
 */
function normalizeToJid(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('@')) return value.toLowerCase();
  const digits = phoneDigits(value);
  return digits && digits.length <= PHONE_MAX_DIGITS ? `${digits}@c.us` : null;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);

  const suggestions = useMemo(() => {
    const query = text.trim().toLowerCase();
    const chosen = new Set(value);
    return (
      chats
        .filter(c => !chosen.has(c.id))
        .filter(c => !query || c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
        // The dropdown scrolls, so this only bounds how much of an account with up to 1000 chats is
        // rendered on every keystroke. Typing narrows the list further.
        .slice(0, 50)
    );
  }, [text, chats, value]);

  const labelFor = (jid: string) => chats.find(c => c.id === jid)?.name ?? jid;
  const add = (jid: string) => {
    if (jid && !value.includes(jid)) onChange([...value, jid]);
    setText('');
    // A suggestion picked with the keyboard holds focus and is about to leave the list; keep focus in the field.
    inputRef.current?.focus();
  };
  const addTyped = () => {
    const jid = normalizeToJid(text);
    if (jid) add(jid);
  };

  return (
    <div
      className="chips-input"
      // The list closes only when focus leaves the whole widget: Tab from the field lands on the first suggestion,
      // which a close on the field's own blur would remove from under the keyboard.
      onFocus={() => clearTimeout(blurTimer.current)}
      onBlur={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        blurTimer.current = setTimeout(() => setOpen(false), 120);
      }}
    >
      <div className="chips-row">
        {value.map(jid => (
          <span key={jid} className="chip" title={jid}>
            {labelFor(jid)}
            <button
              type="button"
              className="chip-remove"
              onClick={e => {
                // A focused X is about to leave the page, and focus with it, unseen by the widget's blur; keep it in
                // the field. An X clicked without taking focus (Safari) leaves focus where it was.
                if (document.activeElement === e.currentTarget) inputRef.current?.focus();
                onChange(value.filter(v => v !== jid));
              }}
              aria-label={t('webhooks.filters.removeValue', { value: labelFor(jid) })}
              title={t('webhooks.filters.removeValue', { value: labelFor(jid) })}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="chips-text"
          value={text}
          placeholder={t('webhooks.filters.contactPlaceholder')}
          onChange={e => setText(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (isComposingKey(e.nativeEvent)) return;
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
          {isTooLong(text) && (
            <div className="chips-suggestion-note" role="status">
              {t('messageTester.tooLong', { max: PHONE_MAX_DIGITS })}
            </div>
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
    emit(
      conditions.map((c, i) => {
        if (i !== index) return c;
        const next = { ...c, ...patch };
        rowKeys.set(next, rowKeyFor(c));
        return next;
      }),
    );

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
          <div key={rowKeyFor(condition)} className="filter-row">
            <select
              className="filter-field"
              aria-label={t('webhooks.filters.fieldLabel')}
              value={condition.field}
              onChange={e => changeField(index, e.target.value)}
            >
              {MESSAGE_FIELDS.map(f => (
                <option key={f.field} value={f.field}>
                  {t(`webhooks.filters.fields.${f.field}`)}
                </option>
              ))}
            </select>

            <select
              className="filter-operator"
              aria-label={t('webhooks.filters.operatorLabel')}
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
                        aria-pressed={selected}
                        className={`enum-tag ${selected ? 'selected' : ''}`}
                        onClick={() => {
                          const current = Array.isArray(condition.value) ? (condition.value as string[]) : [];
                          updateAt(index, {
                            value: selected ? current.filter(v => v !== option) : [...current, option],
                          });
                        }}
                      >
                        {filterValueLabel(t, def.field, option)}
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
                    maxLength={MAX_FILTER_TEXT_LENGTH}
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
                  aria-label={t('webhooks.filters.valueLabel')}
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

      <button
        type="button"
        className="filter-add"
        onClick={addCondition}
        disabled={conditions.length >= MAX_FILTER_CONDITIONS}
      >
        <Plus size={14} />
        {t('webhooks.filters.addCondition')}
      </button>
    </div>
  );
}
