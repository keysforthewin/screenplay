import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { BeatCharacters } from '../widgets/BeatCharacters.jsx';
import { ArtworkTab } from '../widgets/ArtworkTab.jsx';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { ReferenceExtrasSection } from '../widgets/ReferenceExtrasSection.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';
import { BeatTabs } from '../widgets/BeatTabs.jsx';
import { CritiqueTab } from '../widgets/CritiqueTab.jsx';
import { PlayBeatButton } from '../widgets/PlayBeatButton.jsx';
import { VoiceSelect } from '../widgets/VoiceSelect.jsx';
import { readFragmentText } from '../editor/fragmentRead.js';

// The beat editor is split into two page-level sections, reached via <BeatTabs>:
//   writing  (/beat/:order)    → Story, Characters, Critique
//   artwork  (/artwork/:order) → Artwork, Attachments, References
// Both render this component (chosen by the `section` prop) over the same
// beat:<id> y-doc room. The `background` tab is labelled "Story".
const SECTION_TABS = {
  writing: ['background', 'characters', 'critique'],
  artwork: ['artwork', 'attachments', 'references'],
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
  const [allBeatImages, setAllBeatImages] = useState([]);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(() => readInitialTab(section));
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [liveDoc, setLiveDoc] = useState(null);

  // <BeatTabs> reuses this component across the writing/artwork routes (same
  // type, same router slot), so switching sections updates `section` without a
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
        const imgs = await apiGet(`/beat/${r.beat._id}/images`);
        if (!cancelled) setAllBeatImages(imgs.images || []);
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

  const beatImageIds = new Set(
    (beat?.images || []).map((i) => i._id?.toString?.() || String(i._id)),
  );
  const extraReferenceImages = allBeatImages.filter(
    (img) => !beatImageIds.has(img._id?.toString?.() || String(img._id)),
  );

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

  const basePath = section === 'artwork' ? '/artwork' : '/beat';

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
          <DownloadAllButton
            path={`/beat/${beat._id}/download`}
            filename={`beat-${beat.order}.zip`}
            label="Download beat"
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

        {tabs.includes('artwork') && (
          <div className="tab-panel" hidden={currentTab !== 'artwork'}>
            <ArtworkTab
              hostType="beat"
              hostId={beat._id}
              hostLabel={beat.name || `Beat ${beat.order}`}
              artworks={beat.artworks || []}
              hostImages={beat.images || []}
              hostArtworks={beat.artworks || []}
              mainImageId={beat.main_image_id}
              mainPath={`/beat/${beat._id}/main-image`}
              onChange={onRefresh}
            />
          </div>
        )}

        {tabs.includes('attachments') && (
          <div className="tab-panel" hidden={currentTab !== 'attachments'}>
            <p className="tab-intro">
              <strong>Images</strong> are reference images used to create artwork for this beat.{' '}
              <strong>Files</strong> are reference material such as PDFs, Word documents, and audio samples.
            </p>
            <div className="tab-actions">
              <button
                type="button"
                className="primary"
                onClick={() => setImagePickerOpen(true)}
              >
                + Add image
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => setFilePickerOpen(true)}
              >
                + Add file
              </button>
            </div>
            <ImageGallery
              images={beat.images || []}
              mainImageId={beat.main_image_id}
              onChange={onRefresh}
              uploadPath={`/beat/${beat._id}/image`}
              deletePath={(imageId) => `/beat/${beat._id}/image/${imageId}`}
              mainPath={`/beat/${beat._id}/main-image`}
              editPath={(imageId) => `/beat/${beat._id}/image/${imageId}/regenerate`}
              moveToLibraryPath={(imageId) =>
                `/beat/${beat._id}/image/${imageId}/move-to-library`
              }
              attachPath={`/beat/${beat._id}/image/attach`}
              generatePath={`/beat/${beat._id}/image/generate`}
              characterSourcesPath={`/images/by-owner/characters`}
              beatSourcesPath={`/images/by-owner/beats?exclude_id=${beat._id}`}
              copyPath={`/beat/${beat._id}/image/copy`}
              pickerTitle="Add image to beat"
              hideAddButton
              pickerOpen={imagePickerOpen}
              onPickerOpenChange={setImagePickerOpen}
            />
            <AttachmentList
              attachments={beat.attachments || []}
              onChange={onRefresh}
              uploadPath={`/beat/${beat._id}/attachment`}
              deletePath={(id) => `/beat/${beat._id}/attachment/${id}`}
              attachPath={`/beat/${beat._id}/attachment/attach`}
              pickerTitle="Add file to beat"
              fieldPrefix="attachment"
              hideAddButton
              pickerOpen={filePickerOpen}
              onPickerOpenChange={setFilePickerOpen}
            />
          </div>
        )}

        {tabs.includes('references') && (
          <div className="tab-panel" hidden={currentTab !== 'references'}>
            <p className="tab-intro">
              Reference images attached to this beat by its storyboards — frame
              snapshots and per-frame uploads. Manage gallery images on the
              Attachments tab.
            </p>
            <ReferenceExtrasSection
              items={extraReferenceImages}
              deletePath={(id) => `/beat/${beat._id}/orphan-image/${id}`}
              onChange={onRefresh}
              emptyText="No storyboard reference images on this beat yet."
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
    case 'characters': return 'Characters';
    case 'background': return 'Story';
    case 'critique': return 'Critique';
    case 'attachments': return 'Attachments';
    case 'references': return 'References';
    case 'artwork': return 'Artwork';
    default: return tab;
  }
}
