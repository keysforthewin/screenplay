import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiPostJson, thumbUrl } from '../api.js';

const DEFAULT_COUNT = 11;
const MIN_COUNT = 3;
const MAX_COUNT = 30;

const TABS = [
  { key: 'setup', label: 'Setup' },
  { key: 'beat', label: 'Beat' },
  { key: 'characters', label: 'Characters' },
  { key: 'preview', label: 'Prompt preview' },
];

function clampCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(v)));
}

// Pre-generation modal for the page-level "Generate" button. Tabs:
//   - Setup:     count + Analyze, director's commentary
//   - Beat:      read-only preview of the beat text the LLM will see
//   - Characters: read-only preview of the characters that will be supplied
//   - Prompt preview: the Pass 1 (scene plan) system + user prompts, plus the
//                     Pass 2 (shot expansion) system prompt
//
// Existing storyboards replacement warning sits above the tab strip.
export function StoryboardGenerateDialog({
  open,
  onClose,
  onSubmit,
  beat = null,
  beatCharacters = [],
  existingCount = 0,
}) {
  const [tab, setTab] = useState('setup');
  const [count, setCount] = useState(() =>
    existingCount > 0 ? clampCount(existingCount) : DEFAULT_COUNT,
  );
  const [direction, setDirection] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeNote, setAnalyzeNote] = useState(null);
  const [analyzeError, setAnalyzeError] = useState(null);

  // Prompt preview state. Cache keyed by `${count}|${direction}` so switching
  // tabs doesn't refetch and re-rendering the panel is free.
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [preview, setPreview] = useState(null); // { key, system, user, expand_system }
  const previewDebounce = useRef(null);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTab('setup');
    setCount(existingCount > 0 ? clampCount(existingCount) : DEFAULT_COUNT);
    setDirection('');
    setAnalyzeNote(null);
    setAnalyzeError(null);
    setPreview(null);
    setPreviewError(null);
  }, [open, existingCount]);

  const previewKey = `${clampCount(count)}|${direction.trim()}`;

  // Fetch the preview when the user opens the tab, with a 500ms debounce on
  // count/direction changes. Skip if we already have a fresh result for this
  // key.
  useEffect(() => {
    if (!open) return undefined;
    if (tab !== 'preview') return undefined;
    if (!beat?._id) return undefined;
    if (preview?.key === previewKey) return undefined;
    if (previewDebounce.current) clearTimeout(previewDebounce.current);
    previewDebounce.current = setTimeout(async () => {
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const r = await apiPostJson('/storyboards/preview-prompt', {
          beat_id: beat._id,
          count: clampCount(count),
          direction: direction.trim(),
        });
        setPreview({
          key: previewKey,
          system: r.system || '',
          user: r.user || '',
          expand_system: r.expand_system || '',
        });
      } catch (e) {
        setPreviewError(e.message || 'Failed to load preview.');
      } finally {
        setPreviewBusy(false);
      }
    }, 500);
    return () => {
      if (previewDebounce.current) clearTimeout(previewDebounce.current);
    };
  }, [open, tab, previewKey, beat?._id, preview?.key, count, direction]);

  async function runAnalyze() {
    if (!beat?._id) return;
    setAnalyzing(true);
    setAnalyzeNote(null);
    setAnalyzeError(null);
    try {
      const r = await apiPostJson('/storyboards/analyze-count', {
        beat_id: beat._id,
        direction: direction.trim(),
      });
      if (r.count == null) {
        setAnalyzeError(
          r.reason
            ? `Couldn't suggest a count: ${r.reason}`
            : 'No suggestion returned.',
        );
      } else {
        setCount(clampCount(r.count));
        setAnalyzeNote(
          r.reason
            ? `Suggested ${r.count}: ${r.reason}`
            : `Suggested ${r.count}.`,
        );
      }
    } catch (e) {
      setAnalyzeError(e.message || 'Analyze failed.');
    } finally {
      setAnalyzing(false);
    }
  }

  function submit() {
    onSubmit({
      count: clampCount(count),
      direction: direction.trim(),
    });
  }

  const beatBody = stripMd(beat?.body || '');
  const beatName = stripMd(beat?.name || '') || 'Untitled';

  return (
    <Modal
      open={open}
      title="Generate storyboard"
      onClose={onClose}
      dismissible
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={submit}>
            Generate
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {existingCount > 0 && (
          <div
            style={{
              background: 'var(--accent-bg, rgba(255,255,255,0.04))',
              border: '1px solid var(--err, #f88)',
              padding: '8px 12px',
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            This will delete and replace the existing{' '}
            {existingCount} storyboard {existingCount === 1 ? 'item' : 'items'}.
            If planning fails, your current items are preserved.
          </div>
        )}

        <div className="ref-picker-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={'ref-picker-tab' + (tab === t.key ? ' is-active' : '')}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-tab-panel" role="tabpanel">
          {tab === 'setup' && (
            <SetupPanel
              count={count}
              setCount={setCount}
              direction={direction}
              setDirection={setDirection}
              analyzing={analyzing}
              runAnalyze={runAnalyze}
              analyzeNote={analyzeNote}
              analyzeError={analyzeError}
            />
          )}
          {tab === 'beat' && (
            <BeatPanel name={beatName} body={beatBody} />
          )}
          {tab === 'characters' && (
            <CharactersPanel characters={beatCharacters} />
          )}
          {tab === 'preview' && (
            <PreviewPanel
              busy={previewBusy}
              error={previewError}
              preview={preview}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function SetupPanel({
  count,
  setCount,
  direction,
  setDirection,
  analyzing,
  runAnalyze,
  analyzeNote,
  analyzeError,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <span className="field-label">Target frame count</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <input
            type="number"
            min={MIN_COUNT}
            max={MAX_COUNT}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            style={{ width: 90 }}
          />
          <button
            type="button"
            onClick={runAnalyze}
            disabled={analyzing}
            title="Ask the LLM to suggest a count based on the beat body and your direction."
          >
            {analyzing ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
        {analyzeNote && (
          <p className="modal-help" style={{ marginTop: 6 }}>{analyzeNote}</p>
        )}
        {analyzeError && (
          <p className="modal-help" style={{ marginTop: 6, color: 'var(--err, #f88)' }}>
            {analyzeError}
          </p>
        )}
      </div>

      <div>
        <span className="field-label">Director's Commentary (optional)</span>
        <textarea
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          rows={4}
          placeholder="E.g. lean toward handheld energy and dirty over-the-shoulders, save the wide for the reveal at the end"
          style={{ width: '100%', marginTop: 6, fontSize: 13 }}
        />
      </div>
    </div>
  );
}

function BeatPanel({ name, body }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <p className="preview-section-label">Name</p>
        <div style={{ fontSize: 14 }}>{name}</div>
      </div>
      <div>
        <p className="preview-section-label">Body</p>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
          {body || <span style={{ color: 'var(--fg-muted)' }}>(none)</span>}
        </div>
      </div>
    </div>
  );
}

function CharactersPanel({ characters }) {
  if (!characters?.length) {
    return (
      <p className="ref-picker-empty">No characters attached to this beat.</p>
    );
  }
  return (
    <div className="beat-character-list">
      {characters.map((c) => {
        const name = c.name || '—';
        const actor = stripMd(c.hollywood_actor || '');
        const label = actor ? `${name} (${actor})` : name;
        const thumbId = c.main_image_id;
        return (
          <div key={c._id} className="beat-character-row">
            <div className="beat-character-thumb">
              {thumbId ? (
                <img src={thumbUrl(thumbId)} alt={name} loading="lazy" />
              ) : (
                <div className="beat-character-thumb-placeholder" aria-hidden="true">
                  👤
                </div>
              )}
            </div>
            <div className="beat-character-name">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

function PreviewPanel({ busy, error, preview }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="modal-help" style={{ margin: 0 }}>
        The system and user prompts below are Pass 1 (scene plan): they build the
        scene bible and shot skeleton. Pass 2 (shot expansion) then writes the
        start-frame and video prompts for each shot — its system prompt is shown
        at the bottom.
      </p>
      {busy && !preview && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Loading preview…</p>
      )}
      {error && (
        <p style={{ color: 'var(--err, #f88)', fontSize: 13 }}>{error}</p>
      )}
      {preview && (
        <>
          <div>
            <p className="preview-section-label">System prompt</p>
            <pre>{preview.system}</pre>
          </div>
          <div>
            <p className="preview-section-label">User message</p>
            <pre>{preview.user}</pre>
          </div>
          {preview.expand_system && (
            <div>
              <p className="preview-section-label">
                Pass 2 — shot expansion (system prompt)
              </p>
              <pre>{preview.expand_system}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Minimal client-side markdown stripper for the Beat preview panel. The
// server-side prompt builder strips markdown before sending to the LLM; we
// strip here so the panel matches what the planner will actually see. Keeps
// in sync with src/util/markdown.js#stripMarkdown for the common cases.
function stripMd(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
