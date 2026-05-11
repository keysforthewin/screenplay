import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { BeatCharacters } from '../widgets/BeatCharacters.jsx';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { BeatSpecifics } from './BeatSpecifics.jsx';

const TABS = ['details', 'specifics'];

function readInitialTab() {
  if (typeof window === 'undefined') return 'details';
  const h = (window.location.hash || '').replace(/^#/, '');
  return TABS.includes(h) ? h : 'details';
}

export function Beat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [beat, setBeat] = useState(null);
  const [toc, setToc] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState(readInitialTab);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, t] = await Promise.all([
          apiGet(`/beat?order=${encodeURIComponent(order)}`),
          apiGet('/toc'),
        ]);
        if (!cancelled) {
          setBeat(r.beat);
          setToc(t);
        }
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
      const newHash = tab === 'details' ? '' : `#${tab}`;
      if (window.location.hash !== newHash) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
      }
    }
  }

  const room = beat?._id ? `beat:${beat._id}` : null;

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
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'details'}
          className={`tab-button${activeTab === 'details' ? ' is-active' : ''}`}
          onClick={() => selectTab('details')}
        >
          Details
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'specifics'}
          className={`tab-button${activeTab === 'specifics' ? ' is-active' : ''}`}
          onClick={() => selectTab('specifics')}
        >
          Specifics
        </button>
      </div>

      <CollabSurface room={room} session={session} onPing={onRefresh}>
        <div className="tab-panel" hidden={activeTab !== 'details'}>
          <CollabField label="Name" field="name" />
          <CollabField label="Description" field="desc" />
          <CollabField label="Body" field="body" multiline />

          <div className="field-block">
            <span className="field-label">Images</span>
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
            />
          </div>

          <div className="field-block">
            <span className="field-label">Attachments</span>
            <AttachmentList
              attachments={beat.attachments || []}
              onChange={onRefresh}
              uploadPath={`/beat/${beat._id}/attachment`}
              deletePath={(id) => `/beat/${beat._id}/attachment/${id}`}
              fieldPrefix="attachment"
            />
          </div>

          <div className="field-block">
            <span className="field-label">Characters</span>
            <BeatCharacters beat={beat} toc={toc} onRefresh={onRefresh} />
          </div>
        </div>

        <div className="tab-panel" hidden={activeTab !== 'specifics'}>
          <BeatSpecifics beat={beat} onRefresh={onRefresh} />
        </div>
      </CollabSurface>
    </main>
  );
}
