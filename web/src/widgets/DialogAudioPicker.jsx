import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "From dialog…" picker for the storyboard scene audio slot. Lists every
// dialog item in the scene's beat that has audio attached; selecting one
// copies that audio onto the scene as an independent file.
export function DialogAudioPicker({ storyboardId, beatId, disabled, onCopied }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await apiGet(`/dialogs?beat_id=${encodeURIComponent(beatId)}`);
        if (!cancelled) setItems(r?.dialogs || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, beatId]);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  async function pick(dialogId) {
    setCopying(true);
    setError(null);
    try {
      await apiPostJson(`/storyboard/${storyboardId}/audio/from-dialog`, {
        dialog_id: dialogId,
      });
      setOpen(false);
      await onCopied?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setCopying(false);
    }
  }

  const withAudio = (items || []).filter((d) => d.audio_file_id);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        disabled={disabled || copying}
        onClick={() => setOpen((v) => !v)}
        title="Copy audio from one of this beat's dialog items"
      >
        {copying ? 'Copying…' : 'From dialog…'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 30,
            marginTop: 4,
            background: 'var(--bg-elevated, #1c1c1f)',
            border: '1px solid var(--border, #333)',
            borderRadius: 4,
            minWidth: 260,
            maxWidth: 380,
            maxHeight: 280,
            overflowY: 'auto',
            padding: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {loading && (
            <div style={{ padding: 8, color: 'var(--fg-muted)' }}>Loading…</div>
          )}
          {!loading && error && (
            <div className="error-banner small" style={{ margin: 4 }}>
              {error}
            </div>
          )}
          {!loading && !error && withAudio.length === 0 && (
            <div style={{ padding: 8, color: 'var(--fg-muted)' }}>
              No dialog items in this beat have audio yet.
            </div>
          )}
          {!loading && !error && withAudio.map((d) => {
            const id = d._id?.toString?.() || String(d._id);
            const speaker = stripMd(d.character) || '(no speaker)';
            const excerpt = stripMd(d.body).slice(0, 60) || '(empty)';
            return (
              <button
                key={id}
                type="button"
                disabled={copying}
                onClick={() => pick(id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  padding: '6px 8px',
                  color: 'inherit',
                  cursor: 'pointer',
                  borderRadius: 3,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    'var(--bg-hover, rgba(255,255,255,0.06))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  #{d.order} · {speaker}
                </div>
                <div style={{ color: 'var(--fg-muted)', fontSize: '0.9em' }}>
                  {excerpt}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
