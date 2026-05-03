import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';

export function Beat({ session }) {
  const { order } = useParams();
  const navigate = useNavigate();
  const [beat, setBeat] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/beat?order=${encodeURIComponent(order)}`);
        if (!cancelled) setBeat(r.beat);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [order, refreshKey]);

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
      <h1 style={{ marginTop: 0 }}>Beat #{beat.order}</h1>

      <CollabSurface room={room} session={session} onPing={onRefresh}>
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
          />
        </div>

        <div className="field-block">
          <span className="field-label">Attachments</span>
          <AttachmentList
            attachments={beat.attachments || []}
            onChange={onRefresh}
            uploadPath={`/beat/${beat._id}/attachment`}
            deletePath={(id) => `/beat/${beat._id}/attachment/${id}`}
          />
        </div>
      </CollabSurface>
    </main>
  );
}
