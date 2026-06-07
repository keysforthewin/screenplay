import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { BeatCharacters } from '../widgets/BeatCharacters.jsx';
import { ArtworkTab } from '../widgets/ArtworkTab.jsx';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { ReferenceExtrasSection } from '../widgets/ReferenceExtrasSection.jsx';
import { BeatPager } from '../widgets/BeatPager.jsx';

const TABS = ['characters', 'background', 'attachments', 'references', 'artwork'];

function readInitialTab() {
  if (typeof window === 'undefined') return 'background';
  const h = (window.location.hash || '').replace(/^#/, '');
  return TABS.includes(h) ? h : 'background';
}

export function Beat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [beat, setBeat] = useState(null);
  const [toc, setToc] = useState(null);
  const [allBeatImages, setAllBeatImages] = useState([]);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(readInitialTab);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

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
      const next = readInitialTab();
      setActiveTab(next);
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function selectTab(tab) {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      const newHash = tab === 'background' ? '' : `#${tab}`;
      if (window.location.hash !== newHash) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
      }
    }
  }

  const room = beat?._id ? `beat:${beat._id}` : null;

  const beatImageIds = new Set(
    (beat?.images || []).map((i) => i._id?.toString?.() || String(i._id)),
  );
  const extraReferenceImages = allBeatImages.filter(
    (img) => !beatImageIds.has(img._id?.toString?.() || String(img._id)),
  );

  function onRefresh() { setRefreshKey((k) => k + 1); }

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
      <BeatPager beats={toc?.beats} currentId={beat._id} basePath="/beat" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>Beat #{beat.order}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <DownloadAllButton
            path={`/beat/${beat._id}/download`}
            filename={`beat-${beat.order}.zip`}
          />
          <button
            onClick={() => navigate(`/storyboard/${beat.order}`)}
            title="Open the storyboard for this beat"
          >
            View storyboard
          </button>
        </div>
      </div>

      <div className="tab-nav" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={activeTab === t}
            className={`tab-button${activeTab === t ? ' is-active' : ''}`}
            onClick={() => selectTab(t)}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>

      <CollabSurface room={room} session={session} onPing={onRefresh}>
        <div className="tab-panel" hidden={activeTab !== 'characters'}>
          <BeatCharacters beat={beat} toc={toc} onRefresh={onRefresh} />
        </div>

        <div className="tab-panel" hidden={activeTab !== 'background'}>
          <CollabField label="Name" field="name" />
          <CollabField label="Body" field="body" multiline />
        </div>

        <div className="tab-panel" hidden={activeTab !== 'attachments'}>
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

        <div className="tab-panel" hidden={activeTab !== 'references'}>
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

        <div className="tab-panel" hidden={activeTab !== 'artwork'}>
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
      </CollabSurface>

      <BeatPager beats={toc?.beats} currentId={beat._id} basePath="/beat" />
    </main>
  );
}

function tabLabel(tab) {
  switch (tab) {
    case 'characters': return 'Characters';
    case 'background': return 'Background';
    case 'attachments': return 'Attachments';
    case 'references': return 'References';
    case 'artwork': return 'Artwork';
    default: return tab;
  }
}
