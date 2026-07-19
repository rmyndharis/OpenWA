import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  /** Whether the dialog is shown. When false, renders nothing. */
  open: boolean;
  /** Called on Escape, overlay click, and the header close button. */
  onClose: () => void;
  /** Dialog title — rendered in the pinned header and referenced by aria-labelledby. */
  title: ReactNode;
  children: ReactNode;
  /** Optional pinned footer (action buttons), kept visible while the body scrolls. */
  footer?: ReactNode;
  /** Extra class(es) on the .modal card (e.g. 'confirm-modal', 'install-modal'). */
  className?: string;
  /** aria-label for the header close button. */
  closeLabel?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared accessible modal dialog: role="dialog", aria-modal, Escape/overlay close, body scroll
 * lock, initial focus, and a minimal focus trap. Markup uses the GLOBAL modal styles
 * (.modal-overlay/.modal/.modal-header/.modal-body/.modal-footer from index.css), so the card
 * gets the 90vh cap with pinned header/footer and a scrolling body for free.
 *
 * Every page previously hand-rolled the overlay+dialog without any dialog semantics; new modals
 * must use this component, and existing ones are being migrated to it.
 */
export function Modal({ open, onClose, title, children, footer, className, closeLabel = 'Close' }: ModalProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Capture phase: nested widgets (selects, menus) may also listen for Escape — the dialog
        // owns dismissal while it is open.
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const focusables = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          el => el.offsetParent !== null,
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Initial focus: the first visible focusable in the dialog, else the dialog card itself.
    const card = cardRef.current;
    const initial =
      card && (Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).find(el => el.offsetParent !== null) ?? null);
    (initial ?? card)?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        // Close only on a press that STARTS on the overlay itself — a drag that begins inside the
        // dialog and ends outside must not dismiss it (e.g. selecting text outwards).
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={closeLabel}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
