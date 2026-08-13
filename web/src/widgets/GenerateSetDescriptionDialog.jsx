import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { BeatMultiSelect } from './BeatMultiSelect.jsx';
import { apiGet, apiPostJson } from '../api.js';

// "Auto-generate from beats" for a set's description: pick which of the beats
// referencing this set to read, then run one LLM pass that REPLACES the
// description with several visual paragraphs. The write goes through the
// collab gateway, so the open description editor fills in live while the
// request is still in flight.
export function GenerateSetDescriptionDialog({ open, onClose, onDone, setId, setName }) {
  const [beats, setBeats] = useState(null); // null = loading
  const [selectedIds, setSelectedIds] = useState([]);
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const openSeqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      return;
    }
    setError(null);
    setBusy(false);
    setDirection('');
    setBeats(null);
    setSelectedIds([]);
    const seq = openSeqRef.current;
    (async () => {
      try {
        const r = await apiGet(`/set/${setId}/beats`);
        if (seq !== openSeqRef.current) return;
        const list = Array.isArray(r?.beats) ? r.beats : [];
        setBeats(list);
        setSelectedIds(list.map((b) => b._id));
      } catch (e) {
        if (seq !== openSeqRef.current) return;
        setBeats([]);
        setError(e?.message || 'Could not load the beat list');
      }
    })();
  }, [open, setId]);

  async function submit() {
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      await apiPostJson(`/set/${setId}/generate-description`, {
        beat_ids: selectedIds,
        direction: direction.trim(),
      });
      if (seq !== openSeqRef.current) return;
      await onDone?.();
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Auto-generate failed');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  const canSubmit = beats != null && !busy && (beats.length === 0 || selectedIds.length > 0);

  return (
    <Modal
      open={open}
      title="Auto-generate description"
      onClose={onClose}
      dismissible={!busy}
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={submit} disabled={!canSubmit}>
            {busy ? 'Writing… this can take a minute' : 'Generate description'}
          </button>
        </>
      }
    >
      <div className="frame-generate-modal">
        <p className="tab-intro" style={{ marginTop: 0 }}>
          Reads the selected beats and writes a multi-paragraph visual
          description of {setName ? <strong>{setName}</strong> : 'this set'} —
          the kind of concrete, physical detail image generation can use.
          {' '}<strong>The current description will be replaced.</strong>
        </p>
        {beats == null ? (
          <span className="frame-generate-help">Loading beats…</span>
        ) : (
          <BeatMultiSelect
            beats={beats}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
            disabled={busy}
            label="Beats to read"
          />
        )}
        <div>
          <span className="field-label">Optional guidance</span>
          <textarea
            className="image-sheet-feedback"
            rows={2}
            value={direction}
            placeholder="e.g. Emphasize the night-time look; the diner is 1950s."
            onChange={(e) => setDirection(e.target.value)}
            disabled={busy}
            style={{ width: '100%' }}
          />
        </div>
        {busy && (
          <span className="frame-generate-help">
            Writing… the description field updates live as soon as the model
            finishes — you can watch it land on the page behind this dialog.
          </span>
        )}
        {error && <div className="error-banner">{error}</div>}
      </div>
    </Modal>
  );
}
