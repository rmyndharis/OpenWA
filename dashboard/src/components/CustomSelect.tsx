import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import './CustomSelect.css';

export interface CustomSelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  ariaLabel?: string;
}

export function CustomSelect({ value, onChange, options, ariaLabel }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeAheadBuffer = useRef('');
  const typeAheadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const selectedOption = options.find(opt => opt.value === value);
  const selectedLabel = selectedOption?.label ?? '';

  const close = useCallback(() => {
    setIsOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    setIsOpen(prev => {
      if (!prev) {
        const idx = options.findIndex(opt => opt.value === value);
        setFocusedIndex(idx >= 0 ? idx : 0);
      }
      return !prev;
    });
  }, [options, value]);

  const selectOption = useCallback(
    (optValue: string) => {
      onChange(optValue);
      close();
    },
    [onChange, close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          toggle();
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          close();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex(prev => (prev < options.length - 1 ? prev + 1 : 0));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex(prev => (prev > 0 ? prev - 1 : options.length - 1));
          break;
        case 'Home':
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setFocusedIndex(options.length - 1);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < options.length) {
            selectOption(options[focusedIndex].value);
          }
          break;
        case 'Tab':
          close();
          break;
        default:
          if (e.key.length === 1) {
            typeAheadBuffer.current += e.key.toLowerCase();
            clearTimeout(typeAheadTimer.current);
            typeAheadTimer.current = setTimeout(() => { typeAheadBuffer.current = ''; }, 500);
            const match = options.findIndex(opt =>
              opt.label.toLowerCase().startsWith(typeAheadBuffer.current),
            );
            if (match >= 0) setFocusedIndex(match);
          }
          break;
      }
    },
    [isOpen, options, focusedIndex, toggle, close, selectOption],
  );

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        close();
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen, close]);

  useEffect(() => {
    if (isOpen && focusedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll<HTMLButtonElement>('.custom-select-option');
      items[focusedIndex]?.focus();
    }
  }, [isOpen, focusedIndex]);

  useEffect(() => {
    return () => clearTimeout(typeAheadTimer.current);
  }, []);

  return (
    <div className="custom-select" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
      >
        <span className="custom-select-label">{selectedLabel}</span>
        <ChevronDown size={16} className={`custom-select-chevron ${isOpen ? 'open' : ''}`} />
      </button>
      {isOpen && (
        <div className="custom-select-dropdown" ref={listRef} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={option.value}
              id={`option-${option.value}`}
              type="button"
              className={`custom-select-option ${option.value === value ? 'selected' : ''} ${index === focusedIndex ? 'focused' : ''}`}
              role="option"
              aria-selected={option.value === value}
              onClick={() => selectOption(option.value)}
              onMouseEnter={() => setFocusedIndex(index)}
              tabIndex={-1}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
