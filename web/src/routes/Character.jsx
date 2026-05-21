import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { ArtworkTab } from '../widgets/ArtworkTab.jsx';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { ReferenceExtrasSection } from '../widgets/ReferenceExtrasSection.jsx';

const TABS = ['background', 'attachments', 'references', 'artwork'];

function readInitialTab() {
  if (typeof window === 'undefined') return 'background';
  const h = (window.location.hash || '').replace(/^#/, '');
  return TABS.includes(h) ? h : 'background';
}

export function Character({ session }) {
  const { name } = useParams();
  const navigate = useNavigate();
  const [character, setCharacter] = useState(null);
  const [template, setTemplate] = useState(null);
  const [allCharacterImages, setAllCharacterImages] = useState([]);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(readInitialTab);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, t] = await Promise.all([
          apiGet(`/character?name=${encodeURIComponent(name)}`),
          apiGet('/template'),
        ]);
        if (cancelled) return;
        setCharacter(c.character);
        setTemplate(t.character_template);
        const imgs = await apiGet(`/character/${c.character._id}/images`);
        if (!cancelled) setAllCharacterImages(imgs.images || []);
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
  if (!character || !template) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading character…</p></div>;
  }

  const room = `character:${character._id}`;
  const customFields = (template.fields || []).filter((f) => !f.core);

  const characterImageIds = new Set(
    (character.images || []).map((i) => i._id?.toString?.() || String(i._id)),
  );
  const extraReferenceImages = allCharacterImages.filter(
    (img) => !characterImageIds.has(img._id?.toString?.() || String(img._id)),
  );

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>{character.name || 'Character'}</h1>
        <DownloadAllButton
          path={`/character/${character._id}/download`}
          filename={`${(character.name || 'character').replace(/[^a-zA-Z0-9._-]+/g, '_')}.zip`}
        />
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
        <div className="tab-panel" hidden={activeTab !== 'background'}>
          <CollabField label="Name" field="name" />
          <CollabField label="Hollywood actor" field="hollywood_actor" />

          {customFields.map((f) => (
            <CollabField
              key={f.name}
              label={f.name.replace(/_/g, ' ')}
              field={`fields.${f.name}`}
              multiline
              placeholder={f.description}
            />
          ))}
        </div>

        <div className="tab-panel" hidden={activeTab !== 'attachments'}>
          <p className="tab-intro">
            <strong>Images</strong> are reference images used to create artwork for this character.{' '}
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
            images={character.images || []}
            mainImageId={character.main_image_id}
            onChange={onRefresh}
            uploadPath={`/character/${character._id}/image`}
            deletePath={(imageId) => `/character/${character._id}/image/${imageId}`}
            mainPath={`/character/${character._id}/main-image`}
            editPath={(imageId) =>
              `/character/${character._id}/image/${imageId}/regenerate`
            }
            moveToLibraryPath={(imageId) =>
              `/character/${character._id}/image/${imageId}/move-to-library`
            }
            attachPath={`/character/${character._id}/image/attach`}
            generatePath={`/character/${character._id}/image/generate`}
            characterSourcesPath={`/images/by-owner/characters?exclude_id=${character._id}`}
            beatSourcesPath={`/images/by-owner/beats`}
            copyPath={`/character/${character._id}/image/copy`}
            pickerTitle="Add image to character"
            hideAddButton
            pickerOpen={imagePickerOpen}
            onPickerOpenChange={setImagePickerOpen}
          />
          <AttachmentList
            attachments={character.attachments || []}
            onChange={onRefresh}
            uploadPath={`/character/${character._id}/attachment`}
            deletePath={(id) => `/character/${character._id}/attachment/${id}`}
            attachPath={`/character/${character._id}/attachment/attach`}
            pickerTitle="Add file to character"
            fieldPrefix="attachment"
            hideAddButton
            pickerOpen={filePickerOpen}
            onPickerOpenChange={setFilePickerOpen}
          />
        </div>

        <div className="tab-panel" hidden={activeTab !== 'references'}>
          <p className="tab-intro">
            Reference images attached to this character outside the gallery —
            typically generated or imported orphans. Manage gallery images on
            the Attachments tab.
          </p>
          <ReferenceExtrasSection
            items={extraReferenceImages}
            deletePath={(id) => `/character/${character._id}/orphan-image/${id}`}
            onChange={onRefresh}
            emptyText="No orphan reference images for this character."
          />
        </div>

        <div className="tab-panel" hidden={activeTab !== 'artwork'}>
          <ArtworkTab
            hostType="character"
            hostId={character._id}
            hostLabel={character.name}
            artworks={character.artworks || []}
            hostImages={character.images || []}
            hostArtworks={character.artworks || []}
            mainImageId={character.main_image_id}
            mainPath={`/character/${character._id}/main-image`}
            onChange={onRefresh}
          />
        </div>
      </CollabSurface>
    </main>
  );
}

function tabLabel(tab) {
  switch (tab) {
    case 'background': return 'Background';
    case 'attachments': return 'Attachments';
    case 'references': return 'References';
    case 'artwork': return 'Artwork';
    default: return tab;
  }
}
