import { useEffect, useState } from 'react';

// Full-screen image viewer used by storyboard frames and reference thumbnails.
// Default fits the image to the window; clicking the image toggles to natural
// size with the backdrop becoming scrollable. ESC, backdrop click, or the ×
// button close. Body scroll is locked while open (mirrors Modal.jsx).
export function ImageLightbox({ src, alt, onClose }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!src) return;
    setZoomed(false);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [src, onClose]);

  if (!src) return null;

  function onBackdropClick(e) {
    if (e.target !== e.currentTarget) return;
    onClose?.();
  }

  return (
    <div className="image-lightbox-backdrop" onClick={onBackdropClick}>
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
      <img
        className={zoomed ? 'image-lightbox-img zoomed' : 'image-lightbox-img'}
        src={src}
        alt={alt || ''}
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((z) => !z);
        }}
      />
    </div>
  );
}
