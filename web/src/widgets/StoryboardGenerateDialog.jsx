import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { CharacterSheetSelector } from './CharacterSheetSelector.jsx';
import { apiPostJson } from '../api.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';
const VALID_MODELS = new Set(['gemini', 'openai']);
const MODEL_LABEL = {
  gemini: 'Nano Banana (Gemini)',
  openai: 'OpenAI (gpt-image-2)',
};

const DEFAULT_COUNT = 11;
const MIN_COUNT = 3;
const MAX_COUNT = 30;

const TABS = [
  { key: 'setup', label: 'Setup' },
  { key: 'beat', label: 'Beat' },
  { key: 'characters', label: 'Characters' },
  { key: 'preview', label: 'Prompt preview' },
];

function readStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return VALID_MODELS.has(v) ? v : 'gemini';
  } catch {
    return 'gemini';
  }
}

function clampCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(v)));
}

// Pre-generation modal for the page-level "Generate" button. Tabs:
//   - Setup:     count + Analyze, director's direction, image model, sheet overrides
//   - Beat:      read-only preview of the beat text the LLM will see
//   - Characters: read-only preview of the characters that will be supplied
//   - Prompt preview: the exact Stage A (outline) prompt that will be sent
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
  const [imageModel, setImageModel] = useState(readStoredModel);
  const [sheetOverrides, setSheetOverrides] = useState({});
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
  const [preview, setPreview] = useState(null); // { key, system, user }
  const previewDebounce = useRef(null);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTab('setup');
    setSheetOverrides({});
    setCount(existingCount > 0 ? clampCount(existingCount) : DEFAULT_COUNT);
    setDirection('');
    setAnalyzeNote(null);
    setAnalyzeError(null);
    setPreview(null);
    setPreviewError(null);
  }, [open, existingCount]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, imageModel);
    } catch {}
  }, [imageModel]);

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
        setPreview({ key: previewKey, system: r.system || '', user: r.user || '' });
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
    const cleaned = {};
    for (const [cid, sid] of Object.entries(sheetOverrides)) {
      if (sid) cleaned[cid] = sid;
    }
    onSubmit({
      sheetOverrides: cleaned,
      imageModel,
      count: clampCount(count),
      direction: direction.trim(),
    });
  }

  const beatBody = stripMd(beat?.body || '');
  const beatDesc = stripMd(beat?.desc || '');
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
              imageModel={imageModel}
              setImageModel={setImageModel}
              beatCharacters={beatCharacters}
              sheetOverrides={sheetOverrides}
              setSheetOverrides={setSheetOverrides}
            />
          )}
          {tab === 'beat' && (
            <BeatPanel name={beatName} desc={beatDesc} body={beatBody} />
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
  imageModel,
  setImageModel,
  beatCharacters,
  sheetOverrides,
  setSheetOverrides,
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
        <span className="field-label">Director's direction (optional)</span>
        <textarea
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          rows={4}
          placeholder="E.g. lean toward handheld energy and dirty over-the-shoulders, save the wide for the reveal at the end"
          style={{ width: '100%', marginTop: 6, fontSize: 13 }}
        />
      </div>

      <div>
        <span className="field-label">Image model</span>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}
        >
          {['gemini', 'openai'].map((m) => (
            <label
              key={m}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
            >
              <input
                type="radio"
                name="storyboard-image-model"
                value={m}
                checked={imageModel === m}
                onChange={() => setImageModel(m)}
              />
              {MODEL_LABEL[m]}
            </label>
          ))}
        </div>
      </div>

      {beatCharacters.length > 0 && (
        <div>
          <span className="field-label">Character sheets</span>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              marginTop: 6,
            }}
          >
            {beatCharacters.map((c) => (
              <label
                key={c._id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                }}
              >
                <span style={{ minWidth: 100 }}>{c.name}:</span>
                <CharacterSheetSelector
                  character={c}
                  value={sheetOverrides[c._id] || ''}
                  onChange={(sheetId) =>
                    setSheetOverrides((prev) => ({ ...prev, [c._id]: sheetId }))
                  }
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BeatPanel({ name, desc, body }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <p className="preview-section-label">Name</p>
        <div style={{ fontSize: 14 }}>{name}</div>
      </div>
      <div>
        <p className="preview-section-label">Description</p>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
          {desc || <span style={{ color: 'var(--fg-muted)' }}>(none)</span>}
        </div>
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
    <table className="char-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Role / description</th>
          <th>Plays self</th>
          <th>Actor</th>
          <th>Own voice</th>
        </tr>
      </thead>
      <tbody>
        {characters.map((c) => {
          const role = c.fields?.role || c.fields?.description || '';
          return (
            <tr key={c._id}>
              <td>{c.name || '—'}</td>
              <td style={{ color: 'var(--fg-muted)' }}>{role || '—'}</td>
              <td>{c.plays_self ? 'Yes' : 'No'}</td>
              <td>{c.plays_self ? '—' : c.hollywood_actor || '—'}</td>
              <td>{c.own_voice ? 'Yes' : 'No'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PreviewPanel({ busy, error, preview }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="modal-help" style={{ margin: 0 }}>
        This is the Stage A (outline) prompt. Stage B refines each frame's
        start/end prompts in a separate per-clip pass and isn't previewable
        here.
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
