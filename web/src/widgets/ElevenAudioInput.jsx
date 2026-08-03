import { useRef, useState } from 'react';
import { apiPostMultipart } from '../api.js';
import { AudioRecorder } from './AudioRecorder.jsx';

// One audio reference: choose a file OR record in the browser. Both paths
// upload through the existing playground upload endpoint, so the server-side
// ref-verification (project + owner_type 'playground') just works.

export function ElevenAudioInput({ value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  async function upload(fileOrBlob, filename) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', fileOrBlob, filename);
      const r = await apiPostMultipart('/playground/upload', fd);
      onChange(r.ref);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  if (value) {
    return (
      <div className="eleven-audio-input">
        <span className="playground-chip">
          <span className="playground-chip-glyph">🔊</span>
          <span className="playground-chip-name">{value.filename}</span>
          <button type="button" title="Remove" onClick={() => onChange(null)}>×</button>
        </span>
      </div>
    );
  }

  return (
    <div className="eleven-audio-input">
      {error && <div className="error-banner">{error}</div>}
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? 'Uploading…' : 'Choose audio file'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f, f.name);
          e.target.value = '';
        }}
      />
      <span className="eleven-audio-or">or</span>
      <AudioRecorder disabled={uploading} onRecorded={(blob, name) => upload(blob, name)} />
    </div>
  );
}
