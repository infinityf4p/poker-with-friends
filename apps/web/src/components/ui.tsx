import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RoomMode } from '@poker-with-friends/protocol';
import { Icon, type IconName } from '../icons';
import { navigate } from '../navigation';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className="brand real-brand"
      href="/"
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate('/');
      }}
      aria-label="返回首页"
    >
      <span className="brand-mark real-brand-mark">
        <Icon name="spade" size={23} />
      </span>
      {!compact && (
        <span>
          <strong>Poker with Friends</strong>
        </span>
      )}
    </a>
  );
}

export function ModeBadge({ mode }: { mode: RoomMode }) {
  return (
    <span className={`mode-badge mode-badge--${mode.toLowerCase()}`}>
      <Icon name={mode === 'ONLINE' ? 'cards' : 'table'} size={14} />
      {mode === 'ONLINE' ? '线上牌桌' : '线下牌桌'}
    </span>
  );
}

export function Loading({ label = '正在加载…' }: { label?: string }) {
  return (
    <main className="state-page" role="status" aria-live="polite" aria-busy="true">
      <span className="loader" aria-hidden="true" />
      <p>{label}</p>
    </main>
  );
}

export function ErrorBox({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="real-error" role="alert">
      <span>
        <Icon name="warning" size={17} />
      </span>
      <p>{children}</p>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="关闭提示">
          <Icon name="close" size={17} />
        </button>
      )}
    </div>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  className = '',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </button>
  );
}

let bodyScrollLockCount = 0;
let bodyOverflowBeforeModal = '';
const modalBackgroundLocks = new Map<HTMLElement, { count: number; initiallyInert: boolean }>();

function lockBodyScroll(): () => void {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeModal = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyScrollLockCount += 1;
  return () => {
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeModal;
      bodyOverflowBeforeModal = '';
    }
  };
}

function lockModalBackground(currentBackdrop: HTMLElement | null): () => void {
  const backgrounds = Array.from(document.body.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== currentBackdrop,
  );
  for (const element of backgrounds) {
    const current = modalBackgroundLocks.get(element);
    if (current) {
      current.count += 1;
    } else {
      modalBackgroundLocks.set(element, {
        count: 1,
        initiallyInert: element.hasAttribute('inert'),
      });
    }
    element.setAttribute('inert', '');
  }
  return () => {
    for (const element of backgrounds) {
      const current = modalBackgroundLocks.get(element);
      if (!current) continue;
      current.count -= 1;
      if (current.count > 0) continue;
      if (!current.initiallyInert) element.removeAttribute('inert');
      modalBackgroundLocks.delete(element);
    }
  };
}

export function Modal({
  title,
  children,
  onClose,
  locked = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  locked?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlockBodyScroll = lockBodyScroll();
    const unlockModalBackground = lockModalBackground(dialogRef.current?.parentElement ?? null);
    const frame = window.requestAnimationFrame(() => {
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const firstControl = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!activeElement || !dialogRef.current?.contains(activeElement)) {
        (firstControl ?? dialogRef.current)?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      unlockModalBackground();
      unlockBodyScroll();
      previousFocus?.focus();
    };
  }, []);

  const dialog = (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (!locked && onClose && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`bottom-sheet real-modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          // Cancelling an IME composition also emits Escape — never treat
          // that as a request to close the dialog.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!locked && onClose) {
              event.preventDefault();
              onClose();
            }
            return;
          }
          if (event.key !== 'Tab') return;
          event.stopPropagation();
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          ).filter((control) => control.offsetParent !== null);
          if (!controls.length) return;
          const first = controls[0]!;
          const last = controls[controls.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <h2 id={titleId}>{title}</h2>
          {!locked && onClose && (
            <button
              type="button"
              className="round-button"
              onClick={onClose}
              aria-label={`关闭${title}`}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </header>
        {children}
      </section>
    </div>
  );
  return createPortal(dialog, document.body);
}
