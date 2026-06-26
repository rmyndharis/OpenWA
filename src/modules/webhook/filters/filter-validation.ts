import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import {
  FilterOperator,
  findFieldDefinition,
  MAX_CONDITIONS,
  MAX_TEXT_VALUE_LENGTH,
  MAX_VALUES_PER_CONDITION,
} from './filter-types';

const OPERATORS: FilterOperator[] = ['is', 'isNot', 'contains', 'equals'];

function validateCondition(condition: unknown, index: number): string | null {
  const where = `conditions[${index}]`;
  if (typeof condition !== 'object' || condition === null) return `${where} must be an object`;
  const { field, operator, value, caseSensitive } = condition as Record<string, unknown>;

  if (typeof field !== 'string') return `${where}.field must be a string`;
  const def = findFieldDefinition(field);
  if (!def) return `${where}.field "${field}" is not a recognized filter field`;

  if (typeof operator !== 'string' || !OPERATORS.includes(operator as FilterOperator)) {
    return `${where}.operator "${String(operator)}" is invalid`;
  }
  if (!def.operators.includes(operator as FilterOperator)) {
    return `${where}.operator "${operator}" is not allowed for field "${field}"`;
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    return `${where}.caseSensitive must be a boolean`;
  }

  switch (def.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') return `${where}.value must be a boolean for "${field}"`;
      return null;

    case 'text': {
      if (typeof value !== 'string') return `${where}.value must be a string for "${field}"`;
      if (value.length > MAX_TEXT_VALUE_LENGTH) return `${where}.value exceeds ${MAX_TEXT_VALUE_LENGTH} chars`;
      return null;
    }

    case 'id':
    case 'idArray':
    case 'enum': {
      if (!Array.isArray(value) || value.length === 0) {
        return `${where}.value must be a non-empty array for "${field}"`;
      }
      if (value.length > MAX_VALUES_PER_CONDITION) {
        return `${where}.value exceeds ${MAX_VALUES_PER_CONDITION} entries`;
      }
      for (const v of value) {
        if (typeof v !== 'string' || v.length === 0) return `${where}.value entries must be non-empty strings`;
        if (def.kind === 'enum' && def.enumValues && !def.enumValues.includes(v)) {
          return `${where}.value "${v}" is not a valid ${field}`;
        }
      }
      return null;
    }

    default:
      return `${where} has an unsupported field kind`;
  }
}

/** Pure validator: returns a list of human-readable problems (empty when valid). */
export function collectFilterErrors(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return ['filters must be an object'];
  const conditions = (value as Record<string, unknown>).conditions;
  if (!Array.isArray(conditions)) return ['filters.conditions must be an array'];
  if (conditions.length > MAX_CONDITIONS) return [`filters.conditions exceeds ${MAX_CONDITIONS} entries`];

  const errors: string[] = [];
  conditions.forEach((condition, index) => {
    const error = validateCondition(condition, index);
    if (error) errors.push(error);
  });
  return errors;
}

@ValidatorConstraint({ name: 'isValidWebhookFilters', async: false })
class IsValidWebhookFiltersConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return collectFilterErrors(value).length === 0;
  }
  defaultMessage(args: ValidationArguments): string {
    return collectFilterErrors(args.value).join('; ') || 'Invalid webhook filters';
  }
}

export function IsValidWebhookFilters(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidWebhookFiltersConstraint,
    });
  };
}
