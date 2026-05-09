import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPatchJson, imageUrl } from '../api.js';
import { CharacterSelect } from './CharacterSelect.jsx';

function plainOf(s) {
  if (!s) return '';
  return String(s)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function BeatCharacters({ beat, toc, onRefresh }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);

  const linkedNames = useMemo(() => beat.characters || [], [beat.characters]);

  const tocByPlain = useMemo(() => {
    const map = new Map();
    for (const c of toc?.characters || []) {
      const key = (c.plain_name || plainOf(c.name)).toLowerCase();
      if (key) map.set(key, c);
    }
    return map;
  }, [toc]);

  const linked = useMemo(() => {
    return linkedNames.map((raw) => {
      const plain = plainOf(raw);
      const tocEntry = tocByPlain.get(plain.toLowerCase());
      return { raw, plain, tocEntry };
    });
  }, [linkedNames, tocByPlain]);

  const linkedKeys = useMemo(() => {
    return new Set(linked.map((l) => l.plain.toLowerCase()).filter(Boolean));
  }, [linked]);

  const pickerOptions = useMemo(() => {
    return (toc?.characters || []).filter(
      (c) => !linkedKeys.has((c.plain_name || plainOf(c.name)).toLowerCase()),
    );
  }, [toc, linkedKeys]);

  async function patchCharacters(nextNames) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/beat/${beat._id}`, { characters: nextNames });
      await onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink(rawName) {
    if (!confirm(`Unlink ${plainOf(rawName) || rawName} from this beat?`)) return;
    const next = linkedNames.filter((n) => n !== rawName);
    await patchCharacters(next);
  }

  async function addByPlain(plain) {
    if (!plain) return;
    const next = [...linkedNames, plain];
    await patchCharacters(next);
    setPickerKey((k) => k + 1);
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {linked.length === 0 && (
        <p style={{ color: 'var(--fg-muted)', margin: '4px 0 12px' }}>
          No characters linked yet.
        </p>
      )}
      <div className="beat-character-list">
        {linked.map(({ raw, plain, tocEntry }) => {
          const linkPath = tocEntry?._id
            ? `/character/${tocEntry._id}`
            : `/character/${encodeURIComponent(plain || raw)}`;
          const thumbId = tocEntry?.main_image_id;
          const thumbStr = thumbId?.toString
            ? thumbId.toString()
            : typeof thumbId === 'string'
              ? thumbId
              : null;
          return (
            <div key={raw} className="beat-character-row">
              <div className="beat-character-thumb">
                {thumbStr ? (
                  <img src={imageUrl(thumbStr)} alt={plain || raw} loading="lazy" />
                ) : (
                  <div className="beat-character-thumb-placeholder" aria-hidden="true">
                    👤
                  </div>
                )}
              </div>
              <div className="beat-character-name">
                {tocEntry ? (
                  <Link to={linkPath}>{plain || raw}</Link>
                ) : (
                  <span style={{ color: 'var(--fg-muted)' }}>
                    {plain || raw} <em>(missing)</em>
                  </span>
                )}
              </div>
              <div className="beat-character-actions">
                {tocEntry && (
                  <Link className="icon-link" to={linkPath}>
                    Open
                  </Link>
                )}
                <button onClick={() => unlink(raw)} disabled={busy}>
                  Unlink
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="beat-character-add">
        <CharacterSelect
          key={pickerKey}
          value=""
          characters={pickerOptions}
          disabled={busy}
          onChange={addByPlain}
        />
      </div>
    </div>
  );
}
