import { useEffect, useRef } from 'react';

// Reusable modal. ESC + backdrop click close when `dismissible`. On open the
// first form field inside `children` (or the last footer button as a fallback)
// receives focus, and body scroll is locked. Used by ConfirmDialog and the
// storyboard Edit dialog. Not portal-mounted — there are no z-index conflicts
// in this app and Tippy's body-relative bubble menu is only used inside
// CollabField, which is not rendered in any modal here.
export function Modal({
  open,
  title,
  onClose,
  dismissible = true,
  footer = null,
  wide = false,
  size,
  children,
}) {
  const cardRef = useRef(null);

  // size: 'default' | 'wide' | 'xl'. `wide` kept for back-compat.
  const effectiveSize = size || (wide ? 'wide' : 'default');
  const sizeClass =
    effectiveSize === 'xl' ? ' is-xl'
    : effectiveSize === 'wide' ? ' is-wide'
    : '';

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKey(e) {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKey);

    // Focus the first form field inside the card; fall back to the last
    // footer button. requestAnimationFrame so the DOM has settled.
    requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      const formField = card.querySelector(
        'textarea, input:not([type="hidden"])',
      );
      if (formField) {
        formField.focus();
        return;
      }
      const buttons = card.querySelectorAll('.modal-footer button');
      const last = buttons[buttons.length - 1];
      if (last) last.focus();
    });

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;

  function onBackdropClick(e) {
    if (e.target !== e.currentTarget) return;
    if (dismissible) onClose?.();
  }

  return (
    <div className="modal-backdrop" onClick={onBackdropClick}>
      <div
        ref={cardRef}
        className={'modal-card' + sizeClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        {title && <h2 id="modal-title">{title}</h2>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel}>{cancelLabel}</button>
          <button
            className={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{message}</p>
    </Modal>
  );
}
