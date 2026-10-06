import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { apiDelete, apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { BeatCharacters } from '../widgets/BeatCharacters.jsx';
import { BeatSets } from '../widgets/BeatSets.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';
import { BeatTabs, beatTabBase, beatTabFromLocation, beatTabPath } from '../widgets/BeatTabs.jsx';
import { DialogPanel } from '../widgets/DialogPanel.jsx';
import { ScenesPanel } from '../widgets/ScenesPanel.jsx';
import { CritiqueTab } from '../widgets/CritiqueTab.jsx';
import { CoverageTab } from '../widgets/CoverageTab.jsx';
import { PlayBeatButton } from '../widgets/PlayBeatButton.jsx';
import { readFragmentText } from '../editor/fragmentRead.js';

// The one beat page behind all seven tabs of <BeatTabs>. It is the element of
// three routes — /beat/:order (Story, and by URL hash Sets, Characters,
// Critique, Coverage: /beat/3#sets), /dialog/:order and /scenes/:order — and
// stays mounted while the tab changes, so the header, pager and tab row never
// reload. The five /beat panels share the beat:<id> y-doc room; Dialogue and
// Scenes are their own panels on their own rooms, mounted on the first visit
// and kept mounted (hidden) after that. Beat artwork is retired — sets own
// artwork now (see routes/Set.jsx); the old /artwork/:order route redirects to
// /beat/:order.
export function Beat({ session }) {
  const { order, projectTitle } = useParams();
  const navigate = useNavigate();
  const [beat, setBeat] = useState(null);
  const [toc, setToc] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [liveDoc, setLiveDoc] = useState(null);

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

  // The URL is the one source of the active tab, so links, the pager and
  // Back/Forward all land on the right panel.
  const location = useLocation();
  const currentTab = beatTabFromLocation(location);
  const basePath = beatTabBase(currentTab);
  // The beat's plain name as the TOC has it (what the pager shows too).
  const beatName = (toc?.beats?.find((b) => String(b._id) === String(beat?._id))?.plain_name || '').trim();
  const onStoryRoute = basePath === '/beat';

  // In-page moves (tabs, pager) carry the project prefix: a bare /beat/2 goes
  // through the app-root redirect, which remounts the whole project shell.
  const projectPrefix = `/p/${encodeURIComponent(projectTitle)}`;

  function selectTab(tab) {
    // Panels of the same route swap in place; crossing routes is a history entry.
    navigate(`${projectPrefix}${beatTabPath(tab, order)}`, { replace: beatTabBase(tab) === basePath });
  }

  const room = beat?._id ? `beat:${beat._id}` : null;

  // Dialogue and Scenes mount on the first visit for this beat, then stay.
  const beatId = beat?._id ? String(beat._id) : null;
  const [visited, setVisited] = useState({ beatId: null, tabs: {} });
  useEffect(() => {
    if (!beatId) return;
    setVisited((v) => {
      const tabs = v.beatId === beatId ? v.tabs : {};
      if (v.beatId === beatId && tabs[currentTab]) return v;
      return { beatId, tabs: { ...tabs, [currentTab]: true } };
    });
  }, [beatId, currentTab]);
  const mounted = (tab) => currentTab === tab || (visited.beatId === beatId && Boolean(visited.tabs[tab]));

  function onRefresh() { setRefreshKey((k) => k + 1); }

  // Whole-beat delete. The server cascades to the beat's dialogs, scenes and cuts
  // and images and renumbers the rest, so we land back on the TOC (this beat's
  // /beat/:order URL now points at whatever slid into its slot).
  const [deleting, setDeleting] = useState(false);
  async function deleteBeat() {
    const label = beat.name ? `beat #${beat.order} "${beat.name}"` : `beat #${beat.order}`;
    if (!confirm(`Delete ${label}? Its dialog, scenes and cuts will be deleted too. This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await apiDelete(`/beat/${beat._id}`);
      navigate('/');
    } catch (e) {
      setError(e.message);
      setDeleting(false);
    }
  }

  if (error) {
    return <div className="app"><div className="error-banner">{error}</div></div>;
  }
  if (!beat) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading beat #{order}…</p></div>;
  }

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <BeatPager beats={toc?.beats} currentId={beat._id} basePath={`${projectPrefix}${basePath}`} />
      <h1 className="beat-title" title={`Beat ${beat.order}${beatName ? ` · ${beatName}` : ''}`}>
        Beat {beat.order}{beatName ? ` · ${beatName}` : ''}
      </h1>

      <div className="beat-tabs-row">
        <BeatTabs active={currentTab} onSelect={selectTab} />
        {/* Story tab only. Playback outlives the button (the site-wide mini
            player keeps it); the narration voice is picked on the Admin page. */}
        {currentTab === 'story' && (
          <PlayBeatButton
            order={beat.order}
            name={beatName}
            disabled={!liveDoc}
            getText={() => readFragmentText(liveDoc, 'body')}
          />
        )}
      </div>

      <CollabSurface room={room} session={session} active={onStoryRoute} onPing={onRefresh} onDocReady={setLiveDoc}>
        <div className="tab-panel" hidden={currentTab !== 'story'}>
          <CollabField label="Name" field="name" />
          <CollabField label="Body" field="body" multiline />
        </div>

        <div className="tab-panel" hidden={currentTab !== 'sets'}>
          <BeatSets beat={beat} toc={toc} onRefresh={onRefresh} />
        </div>

        <div className="tab-panel" hidden={currentTab !== 'characters'}>
          <BeatCharacters beat={beat} toc={toc} onRefresh={onRefresh} />
        </div>

        <div className="tab-panel" hidden={currentTab !== 'critique'}>
          <CritiqueTab
            beatId={beat._id}
            hasPreviousBody={Boolean(beat.previous_body)}
            onRefresh={onRefresh}
          />
        </div>

        <div className="tab-panel" hidden={currentTab !== 'coverage'}>
          <CoverageTab beatId={beat._id} />
        </div>
      </CollabSurface>

      {mounted('dialog') && (
        <div className="tab-panel" hidden={currentTab !== 'dialog'}>
          <DialogPanel key={beat._id} beat={beat} toc={toc} session={session} active={currentTab === 'dialog'} />
        </div>
      )}

      {mounted('scenes') && (
        <div className="tab-panel" hidden={currentTab !== 'scenes'}>
          <ScenesPanel key={beat._id} beat={beat} session={session} active={currentTab === 'scenes'} />
        </div>
      )}

      <BeatPager beats={toc?.beats} currentId={beat._id} basePath={`${projectPrefix}${basePath}`} />

      {onStoryRoute && (
        <div className="beat-danger-zone">
          <button type="button" className="danger" disabled={deleting} onClick={deleteBeat}>
            {deleting ? 'Deleting…' : 'Delete beat'}
          </button>
        </div>
      )}
    </main>
  );
}

