import { useEffect, useRef, useState } from 'react';

// In-browser microphone recorder (MediaRecorder). Records to webm/opus where
// supported (Chrome/Firefox) falling back to the browser default (Safari →
// mp4). The parent gets the finished Blob via onRecorded and handles upload.

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return ''; // let the browser choose
}

function extForMime(mime) {
  if (/mp4/.test(mime)) return 'm4a';
  if (/ogg/.test(mime)) return 'ogg';
  return 'webm';
}

export function AudioRecorder({ onRecorded, disabled = false }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState(null);
  const [finalizing, setFinalizing] = useState(false);
  const recorderRef = useRef(null);
  const timerRef = useRef(null);
  const blobRef = useRef(null);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    recorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function start() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return;
    setError(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      blobRef.current = null;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Recording needs a secure (HTTPS) connection and a microphone.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(e.name === 'NotAllowedError'
        ? 'Microphone permission denied — allow it in the browser and retry.'
        : `Could not open the microphone: ${e.message}`);
      return;
    }
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      blobRef.current = blob;
      setPreviewUrl(URL.createObjectURL(blob));
      setFinalizing(false);
    };
    rec.start();
    recorderRef.current = rec;
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }

  function stop() {
    clearInterval(timerRef.current);
    setFinalizing(true);
    recorderRef.current?.stop();
    setRecording(false);
  }

  function use() {
    const blob = blobRef.current;
    if (!blob) return;
    const ext = extForMime(blob.type);
    onRecorded(blob, `recording-${Date.now()}.${ext}`);
    URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    blobRef.current = null;
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div className="eleven-recorder">
      {error && <span className="eleven-recorder-error">{error}</span>}
      {!recording && (
        <button type="button" disabled={disabled || finalizing} onClick={start}>🎙️ Record</button>
      )}
      {recording && (
        <>
          <span className="eleven-recorder-live">● {mm}:{ss}</span>
          <button type="button" onClick={stop}>■ Stop</button>
        </>
      )}
      {previewUrl && !recording && (
        <>
          <audio controls src={previewUrl} preload="metadata" />
          <button type="button" className="primary" onClick={use}>Use this recording</button>
        </>
      )}
    </div>
  );
}
