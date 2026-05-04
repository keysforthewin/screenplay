import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPatchJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';
import { AttachmentList } from '../widgets/AttachmentList.jsx';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';

export function Character({ session }) {
  const { name } = useParams();
  const navigate = useNavigate();
  const [character, setCharacter] = useState(null);
  const [template, setTemplate] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

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
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [name, refreshKey]);

  function onRefresh() { setRefreshKey((k) => k + 1); }

  async function patchBool(field, value) {
    try {
      await apiPatchJson(`/character/${character._id}`, { [field]: value });
    } catch (e) {
      setError(e.message);
    }
  }

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!character || !template) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading character…</p></div>;
  }

  const room = `character:${character._id}`;
  const customFields = (template.fields || []).filter((f) => !f.core);

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

      <CollabSurface room={room} session={session} onPing={onRefresh}>
        <CollabField label="Name" field="name" />
        <CollabField label="Hollywood actor" field="hollywood_actor" />

        <div className="field-block" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <label>
            <input
              type="checkbox"
              defaultChecked={!!character.plays_self}
              onChange={(e) => patchBool('plays_self', e.target.checked)}
            />
            {' '}Plays self
          </label>
          <label>
            <input
              type="checkbox"
              defaultChecked={!!character.own_voice}
              onChange={(e) => patchBool('own_voice', e.target.checked)}
            />
            {' '}Own voice
          </label>
        </div>

        {customFields.map((f) => (
          <CollabField
            key={f.name}
            label={f.name.replace(/_/g, ' ')}
            field={`fields.${f.name}`}
            multiline
            placeholder={f.description}
          />
        ))}

        <div className="field-block">
          <span className="field-label">Images</span>
          <ImageGallery
            images={character.images || []}
            mainImageId={character.main_image_id}
            onChange={onRefresh}
            uploadPath={`/character/${character._id}/image`}
            deletePath={(imageId) => `/character/${character._id}/image/${imageId}`}
            mainPath={`/character/${character._id}/main-image`}
          />
        </div>

        <div className="field-block">
          <span className="field-label">Attachments</span>
          <AttachmentList
            attachments={character.attachments || []}
            onChange={onRefresh}
            uploadPath={null}
            deletePath={null}
          />
        </div>
      </CollabSurface>
    </main>
  );
}
