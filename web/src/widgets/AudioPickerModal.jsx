import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiPostMultipart } from '../api.js';
import { Modal } from './Modal.jsx';

const BASE_TABS = [
  { key: 'upload', label: 'Upload' },
  { key: 'record', label: 'Record' },
];
const DIALOG_TAB = { key: 'dialog', label: 'From dialog' };

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Modal that consolidates the three ways to attach audio to a storyboard
// scene: upload, record from the mic, or copy from a dialog item in the
// same beat. The dialog tab is only shown when `dialogPicker` (storyboard
// id + beat id) is provided; the dialog widget uses just upload/record.
export function AudioPickerModal({
  open,
  onClose,
  uploadEndpoint,
  recordingPrefix = 'recording',
  dialogPicker = null,
  onAttached,
}) {
  const tabs = dialogPicker ? [...BASE_TABS, DIALOG_TAB] : BASE_TABS;
  const [tab, setTab] = useState('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTab('upload');
    setError(null);
    setBusy(false);
  }, [open]);

  async function uploadFile(file) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(uploadEndpoint, fd);
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function pickFromDialog(dialogId) {
    if (!dialogPicker || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(
        `/storyboard/${dialogPicker.storyboardId}/audio/from-dialog`,
        { dialog_id: dialogId },
      );
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      title="Add audio"
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
          {tab === 'upload' && (
            <UploadAudioTab onUpload={uploadFile} busy={busy} />
          )}
          {tab === 'record' && (
            <RecordAudioTab
              onRecorded={uploadFile}
              recordingPrefix={recordingPrefix}
              busy={busy}
              onError={setError}
            />
          )}
          {tab === 'dialog' && dialogPicker && (
            <FromDialogTab
              beatId={dialogPicker.beatId}
              busy={busy}
              onPick={pickFromDialog}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function UploadAudioTab({ onUpload, busy }) {
  const fileInputRef = useRef(null);
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
      <p>Drop an audio file here, or</p>
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
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}

function RecordAudioTab({ onRecorded, recordingPrefix, busy, onError }) {
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const tickRef = useRef(null);

  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop();
      } catch (_) {
        /* noop */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  async function startRecord() {
    onError?.(null);
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      onError?.('Browser microphone recording is not supported here.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_err) {
      onError?.('Microphone access denied or unavailable.');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''].find(
      (t) => !t || MediaRecorder.isTypeSupported(t),
    );
    const recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined,
    );
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const contentType = recorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: contentType });
      chunksRef.current = [];
      if (!blob.size) {
        onError?.('Recording was empty.');
        return;
      }
      const ext = contentType.includes('mp4') ? 'm4a' : 'webm';
      const file = new File(
        [blob],
        `${recordingPrefix}-${Date.now()}.${ext}`,
        { type: contentType },
      );
      onRecorded(file);
    };
    recorder.start();
    recorderRef.current = recorder;
    streamRef.current = stream;
    setRecording(true);
    setRecordingMs(0);
    const startedAt = Date.now();
    tickRef.current = setInterval(() => {
      setRecordingMs(Date.now() - startedAt);
    }, 250);
  }

  function stopRecord() {
    try {
      recorderRef.current?.stop();
    } catch (_) {
      /* noop */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    recorderRef.current = null;
    streamRef.current = null;
    setRecording(false);
  }

  const totalSec = Math.floor(recordingMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(1, '0');
  const ss = String(totalSec % 60).padStart(2, '0');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '24px 12px',
      }}
    >
      {recording ? (
        <>
          <div style={{ fontSize: 32, fontFamily: 'monospace' }}>
            {mm}:{ss}
          </div>
          <button
            type="button"
            className="storyboard-audio-record-btn recording"
            onClick={stopRecord}
            disabled={busy}
          >
            <span className="storyboard-audio-record-dot" />■ Stop recording
          </button>
        </>
      ) : (
        <>
          <p style={{ color: 'var(--fg-muted)', margin: 0 }}>
            Click to start recording from your microphone.
          </p>
          <button
            type="button"
            className="storyboard-audio-record-btn"
            onClick={startRecord}
            disabled={busy}
          >
            <span className="storyboard-audio-record-dot" />Record
          </button>
        </>
      )}
    </div>
  );
}

function FromDialogTab({ beatId, busy, onPick }) {
  const [items, setItems] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!beatId) return undefined;
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const r = await apiGet(`/dialogs?beat_id=${encodeURIComponent(beatId)}`);
        if (!cancelled) setItems(r?.dialogs || []);
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beatId]);

  if (loadError) {
    return <div className="error-banner small">{loadError}</div>;
  }
  if (items === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  const withAudio = items.filter((d) => d.audio_file_id);
  if (!withAudio.length) {
    return (
      <p className="ref-picker-empty">
        No dialog items in this beat have audio yet.
      </p>
    );
  }
  return (
    <div className="ref-picker-dialog-list">
      {withAudio.map((d) => {
        const id = d._id?.toString?.() || String(d._id);
        const speaker = stripMd(d.character) || '(no speaker)';
        const excerpt = stripMd(d.body).slice(0, 120) || '(empty)';
        return (
          <button
            key={id}
            type="button"
            className="ref-picker-dialog-item"
            disabled={busy}
            onClick={() => onPick(id)}
          >
            <div style={{ fontWeight: 600 }}>
              #{d.order} · {speaker}
            </div>
            <div style={{ color: 'var(--fg-muted)', fontSize: '0.9em' }}>
              {excerpt}
            </div>
          </button>
        );
      })}
    </div>
  );
}
