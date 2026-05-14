import { useEffect, useMemo, useRef, useState } from 'react';

// Editable character list rendered as removable pills plus an autocomplete
// combobox to add more, capped at `maxTags`. Mirrors CharacterSelect's
// validation: only existing characters (case-insensitive) can be added;
// legacy stored names that don't match the roster still render as pills so
// the user can remove them.
//
// Props:
//   value        — string[]   current characters_in_scene (plain names)
//   characters   — array      [{ _id, name, plain_name }] from /api/toc
//   maxTags      — number     hard cap on pill count (default 2)
//   disabled     — boolean    disable add/remove
//   onChange     — async (next: string[]) => …  full updated array
export function CharacterTagInput({
  value,
  characters,
  maxTags = 2,
  disabled,
  onChange,
}) {
  const tags = Array.isArray(value) ? value : [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const options = useMemo(() => {
    const taken = new Set(tags.map((t) => String(t).trim().toLowerCase()));
    return (characters || [])
      .map((c) => ({
        id: c._id,
        plain: (c.plain_name || c.name || '').trim(),
      }))
      .filter((c) => c.plain && !taken.has(c.plain.toLowerCase()))
      .sort((a, b) => a.plain.localeCompare(b.plain));
  }, [characters, tags]);

  async function commit(next) {
    setBusy(true);
    setError(null);
    try {
      await onChange?.(next);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function removeAt(idx) {
    if (disabled || busy) return;
    const next = tags.filter((_, i) => i !== idx);
    commit(next);
  }

  function addTag(plainName) {
    const trimmed = plainName.trim();
    if (!trimmed) return;
    if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
    commit([...tags, trimmed]);
  }

  const canAdd = !disabled && !busy && tags.length < maxTags;

  return (
    <span className="storyboard-chars-tags">
      {tags.map((tag, i) => (
        <span className="storyboard-char-tag" key={`${tag}-${i}`}>
          <span className="storyboard-char-tag-label">{tag}</span>
          <button
            type="button"
            className="storyboard-char-tag-remove"
            aria-label={`Remove ${tag}`}
            title={`Remove ${tag}`}
            disabled={disabled || busy}
            onClick={() => removeAt(i)}
          >
            ×
          </button>
        </span>
      ))}
      {canAdd && (
        <TagAddCombobox options={options} onPick={addTag} disabled={busy} />
      )}
      {error && <span className="error-banner small">{error}</span>}
    </span>
  );
}

// Inline combobox: filters `options` on typed query, supports arrow/Enter/Tab/
// Escape commit/cancel keys, calls `onPick(plainName)` when the user commits a
// valid match. Clears itself on commit. No free-text allowed — pressing Enter
// on a non-matching query shows an inline "no match" row.
function TagAddCombobox({ options, onPick, disabled }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [noMatch, setNoMatch] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.plain.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered, highlight]);

  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) {
        setOpen(false);
        setNoMatch(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  function reset() {
    setQuery('');
    setOpen(false);
    setHighlight(0);
    setNoMatch(false);
  }

  function pick(plainName) {
    if (!plainName) return;
    onPick?.(plainName);
    reset();
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = filtered[highlight] || (filtered.length === 1 ? filtered[0] : null);
      if (choice) {
        pick(choice.plain);
      } else if (query.trim()) {
        setNoMatch(true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      reset();
      inputRef.current?.blur();
    } else if (e.key === 'Tab') {
      if (filtered.length === 1 && query.trim()) {
        e.preventDefault();
        pick(filtered[0].plain);
      } else {
        reset();
      }
    }
  }

  function onBlur(e) {
    if (
      containerRef.current &&
      e.relatedTarget &&
      containerRef.current.contains(e.relatedTarget)
    ) {
      return;
    }
    // If the typed query exactly matches an option, accept it; otherwise reset
    // silently. Matches CharacterSelect's blur semantics.
    const q = query.trim().toLowerCase();
    if (!q) {
      reset();
      return;
    }
    const exact = options.find((o) => o.plain.toLowerCase() === q);
    if (exact) pick(exact.plain);
    else reset();
  }

  const showEmpty = open && filtered.length === 0;

  return (
    <span
      className="storyboard-char-tag-add"
      ref={containerRef}
      onBlur={onBlur}
      tabIndex={-1}
    >
      <input
        ref={inputRef}
        type="text"
        className="storyboard-char-tag-input"
        value={query}
        placeholder="+ character"
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          setNoMatch(false);
        }}
        onFocus={() => {
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (
        <ul className="character-select-list" role="listbox">
          {filtered.map((o, i) => (
            <li
              key={o.id}
              role="option"
              aria-selected={i === highlight}
              className={
                'character-select-option' +
                (i === highlight ? ' is-highlight' : '')
              }
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.plain);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {o.plain}
            </li>
          ))}
          {showEmpty && (
            <li className="character-select-empty">
              {query.trim()
                ? `No character matches “${query.trim()}”.`
                : 'No characters available.'}
            </li>
          )}
        </ul>
      )}
      {noMatch && !showEmpty && (
        <span className="character-select-error">
          No character matches “{query.trim()}”.
        </span>
      )}
    </span>
  );
}
