import { DatePicker } from 'rsuite/cjs/index.js';
import ptBR from 'rsuite/cjs/locales/pt_BR.js';
import 'rsuite/dist/rsuite.css';
import {
  fromLocalDateTimeValue,
  isPastCalendarDay,
  isPastHour,
  isPastMinute,
  toLocalDateTimeValue,
} from '../utils/workflowDateTime';

type WorkflowDateTimePickerProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
};

export function WorkflowDateTimePicker({ id, value, onChange, ariaLabel }: WorkflowDateTimePickerProps) {
  return (
    <DatePicker
      id={id}
      aria-label={ariaLabel}
      className="workflow-date-time-picker"
      popupClassName="workflow-date-time-picker-popup"
      value={fromLocalDateTimeValue(value)}
      onChange={date => onChange(toLocalDateTimeValue(date))}
      format="dd/MM/yyyy HH:mm"
      placeholder="dd/mm/aaaa --:--"
      locale={ptBR.DatePicker}
      ranges={[]}
      weekStart={0}
      showMeridiem={false}
      shouldDisableDate={date => isPastCalendarDay(date)}
      shouldDisableHour={(hour, date) => isPastHour(hour, date)}
      shouldDisableMinute={(minute, date) => isPastMinute(minute, date)}
      block
      cleanable
      editable
      preventOverflow
    />
  );
}
