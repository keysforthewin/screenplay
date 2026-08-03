import { useEffect } from 'react';
import { ChatPanel } from './ChatPanel.jsx';

// Below this width the panel overlays the page as a drawer instead of
// docking beside it. Keep in sync with the chat media queries in styles.css.
const DRAWER_MQ = '(max-width: 1400px)';

// Container for the inline AI chat: a fixed right-side <aside> that is a
// docked column on wide screens and a slide-over drawer (with backdrop) on
// narrow ones. Stays mounted once opened — ProjectShell only toggles the
// `open` class — so an in-flight SSE run keeps streaming while hidden.
export function ChatSidePanel({ open, onClose }) {
  // The docked column sits below the sticky header (top: var(--header-h)).
  // Measure the real header height instead of hardcoding it — a stale value
  // would leave a gap (or tuck the panel under the header) whenever fonts,
  // zoom, or header content change its height.
  useEffect(() => {
    const header = document.querySelector('.app-header');
    if (!header) return;
    const apply = () =>
      document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  // Drawer-mode-only behaviors: ESC closes and body scroll locks while the
  // drawer covers the page. In docked column mode the panel is persistent
  // workspace chrome — the page stays scrollable and ESC is left alone.
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia(DRAWER_MQ);
    const prevOverflow = document.body.style.overflow;

    function applyLock() {
      document.body.style.overflow = mq.matches ? 'hidden' : prevOverflow;
    }
    function onKey(e) {
      if (e.key === 'Escape' && mq.matches) onClose?.();
    }
    applyLock();
    mq.addEventListener('change', applyLock);
    window.addEventListener('keydown', onKey);
    return () => {
      mq.removeEventListener('change', applyLock);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  return (
    <>
      <div
        className={'chat-backdrop' + (open ? ' open' : '')}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={'chat-side' + (open ? ' open' : '')} aria-label="AI chat panel">
        <ChatPanel />
      </aside>
    </>
  );
}
