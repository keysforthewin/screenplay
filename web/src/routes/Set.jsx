import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { ArtworkTab } from '../widgets/ArtworkTab.jsx';
import { GenerateSetDescriptionDialog } from '../widgets/GenerateSetDescriptionDialog.jsx';

const TABS = ['background', 'attachments', 'artwork'];

function readInitialTab() {
  if (typeof window === 'undefined') return 'background';
  const h = (window.location.hash || '').replace(/^#/, '');
  return TABS.includes(h) ? h : 'background';
}

export function Set({ session }) {
  const { name } = useParams();
  const navigate = useNavigate();
  const [set, setSet] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(readInitialTab);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [descGenOpen, setDescGenOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await apiGet(`/set?name=${encodeURIComponent(name)}`);
        if (cancelled) return;
        setSet(s.set);
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

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!set) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading set…</p></div>;
  }

  const room = `set:${set._id}`;

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
          <div className="tab-actions">
            <button
              type="button"
              onClick={() => setDescGenOpen(true)}
              title="Read the beats this set appears in and write a visual description"
            >
              Auto-generate from beats
            </button>
          </div>
          <GenerateSetDescriptionDialog
            open={descGenOpen}
            onClose={() => setDescGenOpen(false)}
            onDone={onRefresh}
            setId={set._id}
            setName={set.name}
          />
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
    case 'artwork': return 'Artwork';
    default: return tab;
  }
}
