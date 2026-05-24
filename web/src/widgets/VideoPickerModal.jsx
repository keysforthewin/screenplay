import { useEffect, useRef, useState } from 'react';
import { apiPostJson, apiPostMultipart } from '../api.js';
import { baseContentType } from '../recordingMime.js';
import { MediaReferenceTab } from './MediaReferenceTab.jsx';
import { Modal } from './Modal.jsx';
import { StoryboardSourceTab } from './StoryboardSourceTab.jsx';

const BASE_TABS = [
  { key: 'upload', label: 'Upload' },
  { key: 'record', label: 'Record' },
];
const REFERENCE_TAB = { key: 'reference', label: 'Reference' };
const STORYBOARD_TAB = { key: 'storyboard', label: 'Storyboard' };

// Modal that consolidates the ways to attach a source video to a storyboard
// scene: upload from disk, record with the webcam, or pick an existing
// video attachment already uploaded to a beat or character. The Reference
// tab is shown when `storyboardId` is provided (the standard case).
export function VideoPickerModal({
  open,
  onClose,
  uploadEndpoint,
  storyboardId = null,
  recordingPrefix = 'recording',
  onAttached,
}) {
  const tabs = storyboardId
    ? [...BASE_TABS, REFERENCE_TAB, STORYBOARD_TAB]
    : BASE_TABS;
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

  async function pickFromReference(attachmentId) {
    if (!storyboardId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(
        `/storyboard/${storyboardId}/video-upload/from-attachment`,
        { attachment_id: attachmentId },
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
      title="Add video"
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
            <UploadVideoTab onUpload={uploadFile} busy={busy} />
          )}
          {tab === 'record' && (
            <RecordVideoTab
              onRecorded={uploadFile}
              recordingPrefix={recordingPrefix}
              busy={busy}
              onError={setError}
            />
          )}
          {tab === 'reference' && storyboardId && (
            <MediaReferenceTab
              storyboardId={storyboardId}
              mediaType="video"
              busy={busy}
              onPick={pickFromReference}
            />
          )}
          {tab === 'storyboard' && storyboardId && (
            <StoryboardSourceTab
              storyboardId={storyboardId}
              busy={busy}
              onPick={pickFromReference}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function UploadVideoTab({ onUpload, busy }) {
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
      <p>Drop a video file here, or</p>
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
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}

const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
  '',
];

function RecordVideoTab({ onRecorded, recordingPrefix, busy, onError }) {
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [previewReady, setPreviewReady] = useState(false);
  const previewRef = useRef(null);
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
      onError?.('Browser camera recording is not supported here.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
    } catch (_err) {
      onError?.('Camera/microphone access denied or unavailable.');
      return;
    }
    const mime = VIDEO_MIME_CANDIDATES.find(
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
      // Strip any `;codecs=...` params: an unquoted comma (e.g. vp9,opus) makes
      // the server's multipart parser reject the upload. See recordingMime.js.
      const contentType = baseContentType(recorder.mimeType || mime, 'video/webm');
      const blob = new Blob(chunksRef.current, { type: contentType });
      chunksRef.current = [];
      if (!blob.size) {
        onError?.('Recording was empty.');
        return;
      }
      const ext = contentType.includes('mp4') ? 'mp4' : 'webm';
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
    if (previewRef.current) {
      previewRef.current.srcObject = stream;
      setPreviewReady(true);
    }
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
    if (previewRef.current) {
      previewRef.current.srcObject = null;
    }
    setPreviewReady(false);
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
        padding: '16px 12px',
      }}
    >
      <video
        ref={previewRef}
        autoPlay
        muted
        playsInline
        style={{
          width: '100%',
          maxWidth: 480,
          aspectRatio: '16 / 9',
          background: '#000',
          borderRadius: 4,
          display: previewReady ? 'block' : 'none',
        }}
      />
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
            Click to start recording from your camera and microphone.
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
