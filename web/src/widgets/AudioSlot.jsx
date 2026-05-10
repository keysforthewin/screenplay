import { useEffect, useRef, useState } from 'react';
import { apiDelete, apiPostMultipart, attachmentUrl } from '../api.js';

// Reusable audio attachment widget. Three actions: file upload, browser
// recording via MediaRecorder, delete. Used on storyboard scene cards and
// dialog items.
//
// Props:
//   audioId           — GridFS attachments _id or null
//   uploadEndpoint    — POST URL (multipart with field `file`)
//   deleteEndpoint    — DELETE URL (clears the entity's audio_file_id)
//   recordingPrefix   — base name for recorded files (e.g. `dialog-<id>`)
//   label             — header label, defaults to "Audio"
//   onRefresh         — called after every successful mutation
//   extraActions      — optional ({ busy, recording }) => ReactNode rendered
//                       inline alongside Upload/Record. Use for entity-
//                       specific buttons such as "From dialog…".
export function AudioSlot({
  audioId,
  uploadEndpoint,
  deleteEndpoint,
  recordingPrefix = 'recording',
  label = 'Audio',
  onRefresh,
  extraActions,
}) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const tickRef = useRef(null);
  const url = attachmentUrl(audioId);

  // Stop any active mic stream / timer if the component unmounts mid-record
  // (e.g. user navigates away). Without this the mic indicator would linger.
  useEffect(() => {
    return () => {
      try { recorderRef.current?.stop(); } catch (_) { /* noop */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(uploadEndpoint, fd);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    if (!confirm('Remove audio?')) return;
    setBusy(true);
    try {
      await apiDelete(deleteEndpoint);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startRecord() {
    setError(null);
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setError('Browser microphone recording is not supported here.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_err) {
      setError('Microphone access denied or unavailable.');
      return;
    }
    // webm/opus is the default in Chromium/Firefox; Safari only supports mp4.
    // The server's `audio/*` regex accepts either.
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
      uploadRecording(recorder.mimeType || mime || 'audio/webm');
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
    try { recorderRef.current?.stop(); } catch (_) { /* noop */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    recorderRef.current = null;
    streamRef.current = null;
    setRecording(false);
  }

  async function uploadRecording(contentType) {
    setBusy(true);
    setError(null);
    try {
      const blob = new Blob(chunksRef.current, { type: contentType });
      if (!blob.size) {
        setError('Recording was empty.');
        return;
      }
      const ext = contentType.includes('mp4') ? 'm4a' : 'webm';
      const file = new File([blob], `${recordingPrefix}-${Date.now()}.${ext}`, {
        type: contentType,
      });
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(uploadEndpoint, fd);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      chunksRef.current = [];
      setBusy(false);
    }
  }

  const totalSec = Math.floor(recordingMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(1, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const uploadLabel = url ? 'Replace audio' : '+ Upload audio';

  return (
    <div className="storyboard-audio">
      <div className="storyboard-frame-label">{label}</div>
      {url && (
        <div className="storyboard-audio-row">
          <audio controls src={url} preload="metadata" />
          <button
            type="button"
            disabled={busy || recording}
            onClick={remove}
          >
            ×
          </button>
        </div>
      )}
      <div className="storyboard-audio-actions">
        {recording ? (
          <button
            type="button"
            className="storyboard-audio-record-btn recording"
            onClick={stopRecord}
          >
            <span className="storyboard-audio-record-dot" />■ Stop · {mm}:{ss}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? 'Uploading…' : uploadLabel}
            </button>
            <button
              type="button"
              className="storyboard-audio-record-btn"
              disabled={busy}
              onClick={startRecord}
              title="Record from your microphone"
            >
              <span className="storyboard-audio-record-dot" />Record
            </button>
            {extraActions?.({ busy, recording })}
          </>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={upload}
      />
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}
