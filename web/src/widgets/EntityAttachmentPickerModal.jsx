import { useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet,
  apiPostJson,
  apiPostMultipart,
  attachmentUrl,
} from '../api.js';
import { Modal } from './Modal.jsx';

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileGlyph(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('image/')) return '🖼️';
  if (t.startsWith('audio/')) return '🎵';
  if (t.startsWith('video/')) return '🎬';
  if (t.includes('pdf')) return '📕';
  if (t.startsWith('text/') || t.includes('json') || t.includes('xml')) return '📄';
  if (t.includes('zip') || t.includes('compressed') || t.includes('tar')) return '🗜️';
  return '📎';
}

// Picker for entity attachments (beat, character, notes). Two tabs:
//   library — pick from the global library (re-parents the attachment)
//   upload  — POST a file to `uploadPath`
//
// Required props:
//   uploadPath — POST multipart endpoint
//   attachPath — POST {attachment_id} endpoint to attach a library attachment
//   onAttached — async callback after a successful action
export function EntityAttachmentPickerModal({
  open,
  onClose,
  title = 'Add attachment',
  uploadPath,
  attachPath,
  onAttached,
}) {
  const tabs = useMemo(() => {
    const t = [];
    if (attachPath) t.push({ key: 'library', label: 'Library' });
    if (uploadPath) t.push({ key: 'upload', label: 'Upload' });
    return t;
  }, [attachPath, uploadPath]);

  const [tab, setTab] = useState(tabs[0]?.key || 'upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [libraryAttachments, setLibraryAttachments] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTab(tabs[0]?.key || 'upload');
    setError(null);
    setLibraryAttachments(null);
    setLibraryQuery('');
  }, [open, tabs]);

  useEffect(() => {
    if (!open || tab !== 'library' || libraryAttachments !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet('/library');
        if (!cancelled) setLibraryAttachments(data.attachments || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, libraryAttachments]);

  async function attach(attachmentId) {
    if (busy || !attachPath) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(attachPath, { attachment_id: String(attachmentId) });
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file) {
    if (!file || busy || !uploadPath) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(uploadPath, fd);
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const filteredLibrary = useMemo(() => {
    if (!libraryAttachments) return [];
    const f = libraryQuery.trim().toLowerCase();
    if (!f) return libraryAttachments;
    return libraryAttachments.filter((a) => {
      const name = stripMd(a.name).toLowerCase();
      const filename = String(a.filename || '').toLowerCase();
      const desc = String(a.description || '').toLowerCase();
      return (
        name.includes(f) || filename.includes(f) || desc.includes(f)
      );
    });
  }, [libraryAttachments, libraryQuery]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={<button onClick={onClose}>Cancel</button>}
    >
      <div className="ref-picker">
        <div className="ref-picker-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={
                'ref-picker-tab' + (tab === t.key ? ' is-active' : '')
              }
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="ref-picker-body">
          {tab === 'library' && (
            <LibraryAttachmentTab
              attachments={filteredLibrary}
              loaded={libraryAttachments !== null}
              query={libraryQuery}
              onQuery={setLibraryQuery}
              onPick={attach}
              busy={busy}
            />
          )}
          {tab === 'upload' && (
            <UploadAttachmentTab
              fileInputRef={fileInput}
              onUpload={uploadFile}
              busy={busy}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function LibraryAttachmentTab({
  attachments,
  loaded,
  query,
  onQuery,
  onPick,
  busy,
}) {
  if (!loaded) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  return (
    <>
      <input
        type="search"
        className="ref-picker-search"
        placeholder="Search library attachments…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      {attachments.length === 0 ? (
        <p className="ref-picker-empty">
          {query ? 'No matches.' : 'Library has no attachments.'}
        </p>
      ) : (
        <div className="ref-picker-attachment-list">
          {attachments.map((a) => {
            const id = String(a._id);
            const label = stripMd(a.name) || a.filename || id;
            return (
              <button
                key={id}
                type="button"
                className="ref-picker-attachment-item"
                disabled={busy}
                onClick={() => onPick(id)}
                title={label}
              >
                <div
                  className="attachment-glyph"
                  aria-hidden="true"
                  style={{ fontSize: 22 }}
                >
                  {fileGlyph(a.content_type)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--fg-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.filename}
                    {Number.isFinite(a.size) ? ` · ${formatBytes(a.size)}` : ''}
                  </div>
                </div>
                <a
                  href={attachmentUrl(id)}
                  download={a.filename || id}
                  onClick={(e) => e.stopPropagation()}
                  title="Download"
                  style={{ fontSize: 12 }}
                >
                  ↓
                </a>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

function UploadAttachmentTab({ fileInputRef, onUpload, busy }) {
  const [dragging, setDragging] = useState(false);

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) onUpload(file);
  }

  return (
    <div
      className={'ref-picker-drop' + (dragging ? ' is-dragging' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p>Drop a file here, or</p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
      >
        {busy ? 'Uploading…' : 'Choose file'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}
