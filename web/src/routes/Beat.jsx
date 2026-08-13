import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { BeatCharacters } from '../widgets/BeatCharacters.jsx';
import { BeatSets } from '../widgets/BeatSets.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';
import { BeatTabs } from '../widgets/BeatTabs.jsx';
import { CritiqueTab } from '../widgets/CritiqueTab.jsx';
import { PlayBeatButton } from '../widgets/PlayBeatButton.jsx';
import { VoiceSelect } from '../widgets/VoiceSelect.jsx';
import { readFragmentText } from '../editor/fragmentRead.js';

// The beat editor's writing section (/beat/:order), reached via <BeatTabs>,
// renders this component over the beat:<id> y-doc room. The `background` tab
// is labelled "Story". Beat artwork is retired — sets own artwork now (see
// routes/Set.jsx); the old /artwork/:order route redirects to /beat/:order.
const SECTION_TABS = {
  writing: ['background', 'sets', 'characters', 'critique'],
};

function tabsFor(section) {
  return SECTION_TABS[section] || SECTION_TABS.writing;
}

function readInitialTab(section) {
  const tabs = tabsFor(section);
  if (typeof window === 'undefined') return tabs[0];
  const h = (window.location.hash || '').replace(/^#/, '');
  return tabs.includes(h) ? h : tabs[0];
}

export function Beat({ session, section = 'writing' }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const tabs = tabsFor(section);
  const [beat, setBeat] = useState(null);
  const [toc, setToc] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(() => readInitialTab(section));
  const [liveDoc, setLiveDoc] = useState(null);

  // <BeatTabs> reuses this component across router slots (writing section
  // only, currently), so switching sections updates `section` without a
  // remount — resync the tab to the new section's URL hash (or its first tab).
  useEffect(() => {
    setActiveTab(readInitialTab(section));
  }, [section]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, t] = await Promise.all([
          apiGet(`/beat?order=${encodeURIComponent(order)}`),
          apiGet('/toc'),
        ]);
        if (cancelled) return;
        setBeat(r.beat);
        setToc(t);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [order, refreshKey]);

  useEffect(() => {
    function onHash() {
      setActiveTab(readInitialTab(section));
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [section]);

  function selectTab(tab) {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      const newHash = tab === tabs[0] ? '' : `#${tab}`;
      if (window.location.hash !== newHash) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
      }
    }
  }

  const room = beat?._id ? `beat:${beat._id}` : null;
  // Clamp to the active section so a stale tab (e.g. left over after a section
  // switch on a reused instance) never hides every panel.
  const currentTab = tabs.includes(activeTab) ? activeTab : tabs[0];

  function onRefresh() { setRefreshKey((k) => k + 1); }

  const [bgBusy, setBgBusy] = useState(null); // 'undo' | null
  async function undoBody() {
    setBgBusy('undo');
    try { await apiPostJson(`/beat/${beat._id}/restore-body`, {}); onRefresh(); }
    catch (e) { setError(e.message); } finally { setBgBusy(null); }
  }

  if (error) {
    return <div className="app"><div className="error-banner">{error}</div></div>;
  }
  if (!beat) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading beat #{order}…</p></div>;
  }

  const basePath = '/beat';

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <BeatPager beats={toc?.beats} currentId={beat._id} basePath={basePath} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>Beat #{beat.order}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <VoiceSelect />
          <PlayBeatButton
            key={beat._id}
            disabled={!liveDoc}
            getText={() => readFragmentText(liveDoc, 'body')}
          />
        </div>
      </div>

      <BeatTabs order={beat.order} active={section} />

      <div className="tab-nav" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={currentTab === t}
            className={`tab-button${currentTab === t ? ' is-active' : ''}`}
            onClick={() => selectTab(t)}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>

      <CollabSurface room={room} session={session} onPing={onRefresh} onDocReady={setLiveDoc}>
        {tabs.includes('background') && (
          <div className="tab-panel" hidden={currentTab !== 'background'}>
            {beat.previous_body && (
              <div className="tab-actions">
                <button type="button" disabled={bgBusy} onClick={undoBody}>
                  {bgBusy === 'undo' ? 'Undoing…' : 'Undo'}
                </button>
              </div>
            )}
            <CollabField label="Name" field="name" />
            <CollabField label="Body" field="body" multiline />
          </div>
        )}

        {tabs.includes('sets') && (
          <div className="tab-panel" hidden={currentTab !== 'sets'}>
            <BeatSets beat={beat} toc={toc} onRefresh={onRefresh} />
          </div>
        )}

        {tabs.includes('characters') && (
          <div className="tab-panel" hidden={currentTab !== 'characters'}>
            <BeatCharacters beat={beat} toc={toc} onRefresh={onRefresh} />
          </div>
        )}

        {tabs.includes('critique') && (
          <div className="tab-panel" hidden={currentTab !== 'critique'}>
            <CritiqueTab
              beatId={beat._id}
              hasPreviousBody={Boolean(beat.previous_body)}
              onRefresh={onRefresh}
            />
          </div>
        )}
      </CollabSurface>

      <BeatPager beats={toc?.beats} currentId={beat._id} basePath={basePath} />
    </main>
  );
}

function tabLabel(tab) {
  switch (tab) {
    case 'background': return 'Story';
    case 'sets': return 'Sets';
    case 'characters': return 'Characters';
    case 'critique': return 'Critique';
    default: return tab;
  }
}
