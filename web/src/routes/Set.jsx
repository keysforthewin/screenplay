import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiDelete, apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { ArtworkTab } from '../widgets/ArtworkTab.jsx';
import { ReferenceExtrasSection } from '../widgets/ReferenceExtrasSection.jsx';

// Key the TOC persists its active tab under (web/src/routes/Toc.jsx). Set
// here before navigating back to the TOC after a delete so the visitor lands
// on the Sets tab rather than wherever they last were.
const TOC_ACTIVE_TAB_KEY = 'toc.activeTab';

const TABS = ['background', 'attachments', 'references', 'artwork'];

function readInitialTab() {
  if (typeof window === 'undefined') return 'background';
  const h = (window.location.hash || '').replace(/^#/, '');
  return TABS.includes(h) ? h : 'background';
}

export function Set({ session }) {
  const { name } = useParams();
  const navigate = useNavigate();
  const [set, setSet] = useState(null);
  const [toc, setToc] = useState(null);
  const [allSetImages, setAllSetImages] = useState([]);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(readInitialTab);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, t] = await Promise.all([
          apiGet(`/set?name=${encodeURIComponent(name)}`),
          apiGet('/toc'),
        ]);
        if (cancelled) return;
        setSet(s.set);
        setToc(t);
        const imgs = await apiGet(`/set/${s.set._id}/images`);
        if (!cancelled) setAllSetImages(imgs.images || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [name, refreshKey]);

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

  function onRefresh() { setRefreshKey((k) => k + 1); }

  async function deleteSet() {
    if (!set || deleteBusy) return;
    const tocEntry = toc?.sets?.find((s) => String(s._id) === String(set._id));
    const beatCount = tocEntry ? (tocEntry.beats || []).length : null;
    const beatNote = beatCount != null
      ? ` It is linked to ${beatCount} beat${beatCount === 1 ? '' : 's'}.`
      : '';
    if (!confirm(`Delete "${set.name || 'this set'}"?${beatNote} This cannot be undone.`)) {
      return;
    }
    setDeleteBusy(true);
    setError(null);
    try {
      await apiDelete(`/set/${set._id}`);
      try {
        window.localStorage?.setItem(TOC_ACTIVE_TAB_KEY, 'sets');
      } catch {
        // ignore storage errors
      }
      navigate('/');
    } catch (e) {
      setError(e.message);
      setDeleteBusy(false);
    }
  }

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!set) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading set…</p></div>;
  }

  const room = `set:${set._id}`;

  // NOTE: this component is itself named `Set`, which shadows the global
  // `Set` constructor within this module — use an array + includes() here
  // rather than `new Set(...)` to avoid accidentally self-referencing.
  const setImageIdList = (set.images || []).map(
    (i) => i._id?.toString?.() || String(i._id),
  );
  const extraReferenceImages = allSetImages.filter(
    (img) => !setImageIdList.includes(img._id?.toString?.() || String(img._id)),
  );

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <h1 style={{ marginTop: 0 }}>{set.name || 'Set'}</h1>

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
        <div className="tab-panel" hidden={activeTab !== 'background'}>
          <CollabField label="Name" field="name" />
          <CollabField label="Description" field="description" multiline />

          <div className="danger-zone">
            <h2>Danger zone</h2>
            <p>
              Deleting this set removes it and unlinks it from every beat.
              This cannot be undone.
            </p>
            <button
              type="button"
              className="danger"
              onClick={deleteSet}
              disabled={deleteBusy}
            >
              {deleteBusy ? 'Deleting…' : 'Delete set'}
            </button>
          </div>
        </div>

        <div className="tab-panel" hidden={activeTab !== 'attachments'}>
          <p className="tab-intro">
            <strong>Images</strong> are reference images used to create artwork for this set.{' '}
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
            images={set.images || []}
            mainImageId={set.main_image_id}
            onChange={onRefresh}
            uploadPath={`/set/${set._id}/image`}
            deletePath={(imageId) => `/set/${set._id}/image/${imageId}`}
            mainPath={`/set/${set._id}/main-image`}
            editPath={(imageId) =>
              `/set/${set._id}/image/${imageId}/regenerate`
            }
            moveToLibraryPath={(imageId) =>
              `/set/${set._id}/image/${imageId}/move-to-library`
            }
            attachPath={`/set/${set._id}/image/attach`}
            generatePath={`/set/${set._id}/image/generate`}
            characterSourcesPath={`/images/by-owner/characters`}
            beatSourcesPath={`/images/by-owner/beats`}
            setSourcesPath={`/images/by-owner/sets?exclude_id=${set._id}`}
            copyPath={`/set/${set._id}/image/copy`}
            pickerTitle="Add image to set"
            hideAddButton
            pickerOpen={imagePickerOpen}
            onPickerOpenChange={setImagePickerOpen}
          />
          <AttachmentList
            attachments={set.attachments || []}
            onChange={onRefresh}
            uploadPath={`/set/${set._id}/attachment`}
            deletePath={(id) => `/set/${set._id}/attachment/${id}`}
            attachPath={`/set/${set._id}/attachment/attach`}
            pickerTitle="Add file to set"
            fieldPrefix="attachment"
            hideAddButton
            pickerOpen={filePickerOpen}
            onPickerOpenChange={setFilePickerOpen}
          />
        </div>

        <div className="tab-panel" hidden={activeTab !== 'references'}>
          <p className="tab-intro">
            Reference images attached to this set outside the gallery —
            typically generated or imported orphans. Manage gallery images on
            the Attachments tab.
          </p>
          <ReferenceExtrasSection
            items={extraReferenceImages}
            deletePath={(id) => `/set/${set._id}/orphan-image/${id}`}
            onChange={onRefresh}
            emptyText="No orphan reference images for this set."
          />
        </div>

        <div className="tab-panel" hidden={activeTab !== 'artwork'}>
          <ArtworkTab
            hostType="set"
            hostId={set._id}
            hostLabel={set.name}
            artworks={set.artworks || []}
            hostImages={set.images || []}
            hostArtworks={set.artworks || []}
            mainImageId={set.main_image_id}
            mainPath={`/set/${set._id}/main-image`}
            onChange={onRefresh}
          />
        </div>
      </CollabSurface>
    </main>
  );
}

function tabLabel(tab) {
  switch (tab) {
    case 'background': return 'Description';
    case 'attachments': return 'Attachments';
    case 'references': return 'References';
    case 'artwork': return 'Artwork';
    default: return tab;
  }
}
