import { useEffect, useMemo, useRef, useState } from 'react';

// Combobox: pick a set from the project's roster, or type a free-text
// location (e.g. "INT. WAREHOUSE"). When the typed text matches a roster set
// (case-insensitive on the plain name) the canonical roster name is
// committed; otherwise the trimmed text is committed as-is. Mirrors
// CharacterSelect.jsx exactly, swapped to operate on sets.
//
// Props:
//   value      — current set string (markdown or plain) from Mongo
//   sets       — [{ _id, name, plain_name }] from /api/toc
//   disabled   — disable interaction
//   onChange   — async (plainName) => …  Called when the user commits a
//                value. The wrapping field-block re-renders from the parent's
//                value once the API write returns.
export function SetSelect({ value, sets, disabled, onChange }) {
  const options = useMemo(() => {
    return (sets || [])
      .map((s) => ({
        id: s._id,
        plain: (s.plain_name || s.name || '').trim(),
      }))
      .filter((s) => s.plain)
      .sort((a, b) => a.plain.localeCompare(b.plain));
  }, [sets]);

  const committedPlain = useMemo(() => plainOf(value), [value]);

  const [query, setQuery] = useState(committedPlain);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const containerRef = useRef(null);

  // Keep the input in sync with the committed value when it changes from
  // outside (e.g. after API refresh, or another collaborator's edit).
  useEffect(() => {
    if (!open) setQuery(committedPlain);
  }, [committedPlain, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.plain.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered, highlight]);

  // Click-outside collapses the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) revertAndClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  });

  function revertAndClose() {
    setQuery(committedPlain);
    setOpen(false);
    setError(null);
  }

  async function commit(rawName) {
    const trimmed = String(rawName ?? '').trim();
    if (!trimmed) {
      revertAndClose();
      return;
    }
    // If the typed text matches a roster set (case-insensitive), commit the
    // canonical roster spelling. Otherwise commit the trimmed text as-is
    // (free-text locations like "the docks" or "INT. WAREHOUSE").
    const rosterMatch = options.find(
      (o) => o.plain.toLowerCase() === trimmed.toLowerCase(),
    );
    const finalName = rosterMatch ? rosterMatch.plain : trimmed;
    if (finalName.toLowerCase() === committedPlain.toLowerCase()) {
      // No change — just close. Don't fire onChange.
      setQuery(finalName);
      setOpen(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onChange?.(finalName);
      setQuery(finalName);
      setOpen(false);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (disabled || busy) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlight];
      if (pick) commit(pick.plain);
      else if (filtered.length === 1) commit(filtered[0].plain);
      else if (query.trim()) commit(query);
      else revertAndClose();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revertAndClose();
      inputRef.current?.blur();
    } else if (e.key === 'Tab') {
      // Tab commits the highlighted match if there is exactly one filtered
      // option; otherwise commits the typed text as-is (free-text location)
      // when non-empty, or reverts when empty.
      if (filtered.length === 1 && query.trim()) {
        e.preventDefault();
        commit(filtered[0].plain);
      } else if (query.trim()) {
        e.preventDefault();
        commit(query);
      } else {
        revertAndClose();
      }
    }
  }

  function onBlur(e) {
    // Let click-on-option handlers run first; they call commit() which
    // closes the dropdown. If focus moved into our own list we ignore.
    if (
      containerRef.current &&
      e.relatedTarget &&
      containerRef.current.contains(e.relatedTarget)
    ) {
      return;
    }
    // Commit whatever was typed. commit() handles roster matching internally
    // and falls through to free-text storage when nothing matches.
    const q = query.trim();
    if (!q) revertAndClose();
    else if (q.toLowerCase() === committedPlain.toLowerCase()) revertAndClose();
    else commit(q);
  }

  const showEmpty = open && filtered.length === 0;

  return (
    <div
      className="set-select"
      ref={containerRef}
      onBlur={onBlur}
      tabIndex={-1}
    >
      <input
        ref={inputRef}
        type="text"
        className="set-select-input"
        value={query}
        placeholder="Pick a set or type a location…"
        disabled={disabled || busy}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          setError(null);
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
        <ul className="set-select-list" ref={listRef} role="listbox">
          {filtered.map((o, i) => (
            <li
              key={o.id}
              role="option"
              aria-selected={i === highlight}
              className={
                'set-select-option' +
                (i === highlight ? ' is-highlight' : '')
              }
              onMouseDown={(e) => {
                // Prevent input blur firing before click commits.
                e.preventDefault();
                commit(o.plain);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {o.plain}
            </li>
          ))}
          {showEmpty && (
            <li
              className="set-select-empty set-select-freetext"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(query);
              }}
            >
              Use “{query.trim()}” as a free-text location
            </li>
          )}
        </ul>
      )}
      {error && <div className="set-select-error">{error}</div>}
    </div>
  );
}

// Lightweight markdown stripper for displaying the current value. Mirrors the
// preview function in DialogEditDialog rather than pulling in a parser.
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
