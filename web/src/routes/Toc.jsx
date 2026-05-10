import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';
import { NotesPanel } from '../widgets/NotesPanel.jsx';
import { LibraryPanel } from '../widgets/LibraryPanel.jsx';

const TABS = [
  { id: 'characters', label: 'Characters' },
  { id: 'beats', label: 'Beats' },
  { id: 'dialog', label: 'Dialog' },
  { id: 'storyboards', label: 'Storyboards' },
  { id: 'notes', label: "Director's notes" },
  { id: 'library', label: 'Library' },
];
const TAB_IDS = TABS.map((t) => t.id);
const ACTIVE_TAB_KEY = 'toc.activeTab';

function readInitialTab() {
  if (typeof window === 'undefined') return 'characters';
  try {
    const stored = window.localStorage?.getItem(ACTIVE_TAB_KEY);
    if (stored && TAB_IDS.includes(stored)) return stored;
  } catch {
    // ignore storage errors
  }
  return 'characters';
}

export function Toc({ session }) {
  const [toc, setToc] = useState(null);
  const [notesData, setNotesData] = useState(null);
  const [libraryData, setLibraryData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState(readInitialTab);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await apiGet('/toc');
        if (!cancelled) setToc(t);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refetchNotes = useCallback(async () => {
    try {
      const r = await apiGet('/notes');
      setNotesData(r);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const refetchLibrary = useCallback(async () => {
    try {
      const r = await apiGet('/library');
      setLibraryData(r);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refetchNotes(); }, [refetchNotes]);
  useEffect(() => { refetchLibrary(); }, [refetchLibrary]);

  function selectTab(tab) {
    setActiveTab(tab);
    try {
      window.localStorage?.setItem(ACTIVE_TAB_KEY, tab);
    } catch {
      // ignore storage errors
    }
  }

  const filter = useMemo(() => query.trim().toLowerCase(), [query]);
  // Match the visible label OR the entry's per-tab `search_text` blob, so the
  // user can filter by content (beat body, dialog lines, scene prompts,
  // character fields) and not just by the rendered list label.
  const matches = (label, ...searchBlobs) => {
    if (!filter) return true;
    if (label && label.toLowerCase().includes(filter)) return true;
    for (const s of searchBlobs) {
      if (typeof s === 'string' && s && s.includes(filter)) return true;
    }
    return false;
  };

  if (error) {
    return (
      <div className="app">
        <div className="error-banner">Could not load table of contents: {error}</div>
      </div>
    );
  }

  if (!toc) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading…</p></div>;
  }

  const dupCounts = (toc.characters || []).reduce((m, c) => {
    const k = (c.plain_name || c.name || '').toLowerCase();
    m.set(k, (m.get(k) || 0) + 1);
    return m;
  }, new Map());

  const characters = [...(toc.characters || [])]
    .sort((a, b) => {
      const an = (a.plain_name || a.name || '').toLowerCase();
      const bn = (b.plain_name || b.name || '').toLowerCase();
      return an.localeCompare(bn);
    })
    .map((c) => {
      const nameKey = (c.plain_name || c.name || '').toLowerCase();
      const isDup = (dupCounts.get(nameKey) || 0) > 1;
      return {
        key: c._id,
        to: isDup
          ? `/character/${c._id}`
          : `/character/${encodeURIComponent(c.plain_name || c.name)}`,
        label: c.plain_name || c.name || '',
        beats: c.beats || [],
        isDup,
        idShort: String(c._id).slice(-6),
        searchText: c.search_text || '',
      };
    })
    .filter((c) => matches(c.label, c.searchText));

  const beats = [...(toc.beats || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => ({
      key: b._id,
      to: `/beat/${b.order}`,
      label: `#${b.order} — ${b.plain_name || b.name || 'Untitled'}`,
      bodyEmpty: !!b.body_empty,
      searchText: b.search_text || '',
    }))
    .filter((b) => matches(b.label, b.searchText));

  const dialogBeats = [...(toc.beats || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => {
      const title = b.plain_name || b.name || 'Untitled';
      const count = b.dialog_count || 0;
      const missing = count === 0;
      return {
        key: b._id,
        to: `/dialog/${b.order}`,
        order: b.order,
        title,
        missing,
        count,
        searchLabel: `#${b.order} — ${title}`,
        searchText: b.dialog_search_text || '',
      };
    })
    .filter((b) => matches(b.searchLabel, b.searchText));

  const storyboardBeats = [...(toc.beats || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => {
      const title = b.plain_name || b.name || 'Untitled';
      const count = b.storyboard_count || 0;
      const missing = count === 0;
      return {
        key: b._id,
        to: `/storyboard/${b.order}`,
        order: b.order,
        title,
        missing,
        count,
        searchLabel: `#${b.order} — ${title}`,
        searchText: b.storyboard_search_text || '',
      };
    })
    .filter((b) => matches(b.searchLabel, b.searchText));

  const allNotes = notesData?.notes || [];
  const filteredNotes = !filter
    ? allNotes
    : allNotes.filter((n) => (n.text || '').toLowerCase().includes(filter));

  const libraryImages = libraryData?.images || [];
  const stripForFilter = (s) =>
    String(s || '')
      .replace(/[*_`~]/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const libraryMatchCount = !filter
    ? libraryImages.length
    : libraryImages.filter(
        (img) =>
          stripForFilter(img.name).includes(filter) ||
          String(img.description || '').toLowerCase().includes(filter),
      ).length;
  // Tab is visible without a filter (always), or when the literal "Library"
  // matches the filter, or when at least one image matches the filter on its
  // name/description.
  const libraryVisible =
    !filter || matches('Library') || libraryMatchCount > 0;

  const tabCounts = {
    characters: characters.length,
    beats: beats.length,
    dialog: dialogBeats.length,
    storyboards: storyboardBeats.length,
    notes: filteredNotes.length,
    library: libraryVisible ? Math.max(libraryMatchCount, matches('Library') ? 1 : 0) : 0,
  };
  // While the filter is active, hide tabs whose contents don't match. With no
  // filter, every tab is visible (even when its underlying list is empty).
  const visibleTabs = filter
    ? TABS.filter((t) => tabCounts[t.id] > 0)
    : TABS;
  const visibleTabIds = visibleTabs.map((t) => t.id);
  // The user's chosen tab (persisted) may currently be filtered out — if so,
  // display the first visible tab instead, but don't overwrite the saved
  // preference, so clearing the filter snaps them back.
  const displayedTab = visibleTabIds.includes(activeTab)
    ? activeTab
    : visibleTabIds[0] || activeTab;

  const noResults = filter && visibleTabs.length === 0;

  return (
    <main className="app">
      <h1 style={{ marginBottom: 8 }}>Table of contents</h1>

      <div className="toc-filter">
        <input
          type="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter table of contents"
          autoFocus
        />
        {query && (
          <button
            type="button"
            className="toc-filter-clear"
            aria-label="Clear filter"
            title="Clear filter"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </div>

      {visibleTabs.length > 0 && (
        <div className="tab-nav" role="tablist">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={displayedTab === t.id}
              className={`tab-button${displayedTab === t.id ? ' is-active' : ''}`}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {noResults && (
        <p style={{ color: 'var(--fg-muted)' }}>No items match “{query}”.</p>
      )}

      <div className="tab-panel" hidden={displayedTab !== 'characters' || noResults}>
        {characters.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)' }}>No characters yet.</p>
        ) : (
          <section className="toc-section">
            <ul>
              {characters.map((c) => (
                <li key={c.key} className="toc-character">
                  <Link to={c.to}>{c.label}</Link>
                  {c.isDup && <span className="toc-beat-refs"> · {c.idShort}</span>}
                  {c.beats.length > 0 && (
                    <span className="toc-beat-refs">
                      {' ('}
                      {c.beats.map((b, i) => (
                        <span key={b.order}>
                          {i > 0 && ' · '}
                          <Link to={`/beat/${b.order}`}>{b.plain_name || `Beat ${b.order}`}</Link>
                        </span>
                      ))}
                      {')'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="tab-panel" hidden={displayedTab !== 'beats' || noResults}>
        {beats.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)' }}>No beats yet.</p>
        ) : (
          <section className="toc-section">
            <ul>
              {beats.map((b) => (
                <li key={b.key}>
                  <Link
                    to={b.to}
                    title={b.bodyEmpty ? 'Beat body is empty' : undefined}
                  >
                    {`${b.bodyEmpty ? '* ' : ''}${b.label}`}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="tab-panel" hidden={displayedTab !== 'dialog' || noResults}>
        <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
          Each beat has its own dialog. <strong>*</strong> marks beats with no
          dialog yet.
        </p>
        {dialogBeats.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)' }}>No beats yet.</p>
        ) : (
          <section className="toc-section">
            <ul>
              {dialogBeats.map((b) => {
                const prefix = b.missing ? '* ' : '';
                const suffix = b.missing ? '' : ` (${b.count})`;
                return (
                  <li key={b.key}>
                    <Link
                      to={b.to}
                      title={b.missing ? 'No dialog for this beat yet' : undefined}
                    >
                      {`${prefix}#${b.order} — ${b.title}${suffix}`}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <div className="tab-panel" hidden={displayedTab !== 'storyboards' || noResults}>
        <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
          Each beat has its own storyboard. <strong>*</strong> marks beats with no
          storyboards yet.
        </p>
        {storyboardBeats.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)' }}>No beats yet.</p>
        ) : (
          <section className="toc-section">
            <ul>
              {storyboardBeats.map((b) => {
                const prefix = b.missing ? '* ' : '';
                const suffix = b.missing ? '' : ` (${b.count})`;
                return (
                  <li key={b.key}>
                    <Link
                      to={b.to}
                      title={b.missing ? 'No storyboards for this beat yet' : undefined}
                    >
                      {`${prefix}#${b.order} — ${b.title}${suffix}`}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <div className="tab-panel" hidden={displayedTab !== 'notes' || noResults}>
        {notesData ? (
          <NotesPanel
            notes={filteredNotes}
            session={session}
            onChange={refetchNotes}
          />
        ) : (
          <p style={{ color: 'var(--fg-muted)' }}>Loading notes…</p>
        )}
      </div>

      <div className="tab-panel" hidden={displayedTab !== 'library' || noResults}>
        {libraryData ? (
          <LibraryPanel
            data={libraryData}
            session={session}
            onChange={refetchLibrary}
            query={query}
          />
        ) : (
          <p style={{ color: 'var(--fg-muted)' }}>Loading library…</p>
        )}
      </div>
    </main>
  );
}
