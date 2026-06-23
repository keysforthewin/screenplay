import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ConfirmDialog } from './Modal.jsx';
import { apiGet, apiPatchJson, apiPostJson, apiSseUrl } from '../api.js';
import {
  emptyHistory,
  recordEdit,
  undo as undoHistory,
  redo as redoHistory,
  canUndo,
  canRedo,
} from './beatEditHistory.js';
import { useProject } from '../project/ProjectContext.jsx';
import { useReceivedPageContext } from '../project/usePageContextSync.js';

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function Attachment({ att }) {
  if (att.kind === 'image') {
    return (
      <a href={att.url} target="_blank" rel="noreferrer">
        <img className="chat-attachment-image" src={att.url} alt="generated" />
      </a>
    );
  }
  if (att.kind === 'pdf' || att.kind === 'file') {
    return (
      <a href={att.url} target="_blank" rel="noreferrer">
        {att.filename || att.url.split('/').pop() || 'download'}
      </a>
    );
  }
  return (
    <span className="chat-attachment-unavailable">
      generated <code>{att.filename}</code> — ask in Discord to receive this file
    </span>
  );
}

function ChatMessage({ m }) {
  if (m.role === 'user') {
    return <div className="chat-msg chat-msg-user">{m.text}</div>;
  }
  return (
    <div className="chat-msg chat-msg-assistant">
      {m.pending ? (
        <div className="chat-progress">{m.progressLabel || 'thinking…'}</div>
      ) : (
        <>
          <div className="chat-markdown">
            <ReactMarkdown>{m.text || ''}</ReactMarkdown>
          </div>
          {m.attachments?.length > 0 && (
            <div className="chat-attachments">
              {m.attachments.map((att, i) => (
                <Attachment key={i} att={att} />
              ))}
            </div>
          )}
          {m.interpreted && (
            <div className="chat-interpreted">Interpreted: {m.interpreted}</div>
          )}
        </>
      )}
    </div>
  );
}

// Self-contained AI chat panel rendered in its own popup window. Each send
// POSTs /api/chat (running the shared agent loop against the browser's current
// project) and follows the run via SSE. The transcript is reloaded from the
// server on mount, so it survives the window being closed and reopened. The
// page context ("which scene am I on") is live-synced from the editor window.
export function ChatPanel() {
  const project = useProject();
  const pageCtx = useReceivedPageContext(project.id);
  const [messages, setMessages] = useState([]);
  const [beatHistories, setBeatHistories] = useState({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState(null);
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [lastInputTokens, setLastInputTokens] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const esRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function patchPending(patch) {
    setMessages((prev) => {
      const next = prev.slice();
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].pending) {
          next[i] = { ...next[i], ...patch };
          break;
        }
      }
      return next;
    });
  }

  function finishStream() {
    esRef.current?.close();
    esRef.current = null;
    setBusy(false);
  }

  // Drop the transient "reverted" status when the active page/beat changes.
  useEffect(() => {
    setRestoreStatus(null);
  }, [pageCtx.kind, pageCtx.ref]);

  // Load persisted history once on mount (the window opening is the "open").
  useEffect(() => {
    (async () => {
      try {
        const data = await apiGet('/chat/history');
        if (Array.isArray(data?.messages)) setMessages(data.messages);
        setEstimatedTokens(data?.estimated_tokens ?? 0);
        setLastInputTokens(data?.last_input_tokens ?? null);
      } catch {
        // best-effort: an empty/missing history just starts fresh
      }
    })();
  }, []);

  const beatRef = pageCtx.kind === 'beat' ? pageCtx.ref : null;
  const history = (beatRef && beatHistories[beatRef]) || emptyHistory();

  async function fetchBeatText(ref) {
    try {
      const { beat } = await apiGet(`/beat?order=${encodeURIComponent(ref)}`);
      if (!beat) return null;
      return {
        name: beat.name || '',
        desc: beat.desc || '',
        body: beat.body || '',
      };
    } catch {
      return null;
    }
  }

  async function recordBeatEdit(ref, before) {
    if (!ref || !before) return;
    const after = await fetchBeatText(ref);
    if (!after) return;
    setBeatHistories((prev) => ({
      ...prev,
      [ref]: recordEdit(prev[ref] || emptyHistory(), before, after),
    }));
  }

  async function applyRestore(ref, snapshot, nextHistory) {
    setRestoring(true);
    setError(null);
    setRestoreStatus(null);
    try {
      await apiPatchJson(`/beat/${encodeURIComponent(ref)}/text`, snapshot);
      setBeatHistories((prev) => ({ ...prev, [ref]: nextHistory }));
      setRestoreStatus('Reverted beat text');
    } catch (e) {
      setError(e.message || 'Failed to restore beat text.');
    } finally {
      setRestoring(false);
    }
  }

  function onUndo() {
    if (!beatRef) return;
    const { history: next, snapshot } = undoHistory(beatHistories[beatRef] || emptyHistory());
    if (snapshot) applyRestore(beatRef, snapshot, next);
  }

  function onRedo() {
    if (!beatRef) return;
    const { history: next, snapshot } = redoHistory(beatHistories[beatRef] || emptyHistory());
    if (snapshot) applyRestore(beatRef, snapshot, next);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || restoring) return;
    setError(null);
    setRestoreStatus(null);
    setBusy(true);
    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'assistant', pending: true, progressLabel: 'sending…' },
    ]);
    try {
      const captureRef = pageCtx.kind === 'beat' ? pageCtx.ref : null;
      const before = captureRef ? await fetchBeatText(captureRef) : null;
      const r = await apiPostJson('/chat', { text, context: { kind: pageCtx.kind, ref: pageCtx.ref } });
      const runId = r?.run_id;
      if (!runId) throw new Error('Server did not return a run id.');
      const es = new EventSource(apiSseUrl(`/chat/${runId}/events`));
      esRef.current = es;
      const applySnapshot = (snap) => {
        if (!snap) return;
        if (snap.status === 'done') {
          patchPending({
            pending: false,
            text: snap.text,
            attachments: snap.attachments || [],
            interpreted: snap.interpreted,
          });
          if (typeof snap.estimated_tokens === 'number') setEstimatedTokens(snap.estimated_tokens);
          if (snap.last_input_tokens !== undefined) setLastInputTokens(snap.last_input_tokens);
          if (captureRef && before) recordBeatEdit(captureRef, before);
          finishStream();
        } else if (snap.status === 'error') {
          patchPending({ pending: false, text: `Something went wrong: ${snap.error}` });
          setError(snap.error || 'Agent run failed.');
          finishStream();
        } else {
          const last = snap.progress?.[snap.progress.length - 1];
          if (last?.label) patchPending({ progressLabel: last.label });
        }
      };
      es.addEventListener('snapshot', (ev) => applySnapshot(safeParse(ev.data)));
      es.addEventListener('progress', (ev) => applySnapshot(safeParse(ev.data)));
      es.addEventListener('done', (ev) => applySnapshot(safeParse(ev.data)));
      es.addEventListener('error', (ev) => {
        const data = ev?.data ? safeParse(ev.data) : null;
        if (data) {
          applySnapshot(data);
        } else if (es.readyState === EventSource.CLOSED) {
          patchPending({ pending: false, text: '(connection lost)' });
          setError('Connection lost.');
          finishStream();
        }
      });
    } catch (e) {
      setMessages((prev) => prev.filter((m) => !m.pending));
      setInput(text);
      setError(e.message || 'Failed to send.');
      setBusy(false);
    }
  }

  async function doClear() {
    setConfirmClear(false);
    setError(null);
    try {
      await apiPostJson('/chat/clear', {});
      setMessages([]);
      setEstimatedTokens(0);
      setLastInputTokens(null);
    } catch (e) {
      setError(e.message || 'Failed to clear history.');
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat-window">
      <div className="chat-dialog">
        <div className="chat-toolbar">
          <span className="chat-title">AI chat</span>
          <span className="chat-token-readout" title="Estimated tokens in the conversation history sent each run">
            ~{estimatedTokens.toLocaleString()} tokens
            {lastInputTokens != null && (
              <span className="chat-token-secondary"> · last run {lastInputTokens.toLocaleString()}</span>
            )}
          </span>
          <span className="chat-toolbar-spacer" />
          <button
            type="button"
            className="chat-history-btn"
            onClick={() => setConfirmClear(true)}
            disabled={busy || restoring || messages.length === 0}
            title="Clear this conversation and start fresh"
          >
            🧹 Clear
          </button>
          <button
            type="button"
            className="chat-close-btn"
            onClick={() => window.close()}
            title="Close window"
            aria-label="Close chat window"
          >
            ✕
          </button>
        </div>
        <div className="chat-messages" ref={listRef}>
          {messages.length === 0 && (
            <p className="chat-empty">
              Talk to the screenplay agent about this project — the same
              assistant that lives in Discord.
            </p>
          )}
          {messages.map((m, i) => (
            <ChatMessage key={i} m={m} />
          ))}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div
          className="chat-context-chip"
          title="The agent is told which page you're viewing in the editor window"
          aria-label={`Page context: ${pageCtx.label} — the agent is told which page you're viewing in the editor`}
        >
          Context: {pageCtx.label}
        </div>
        <div className="chat-history-row">
          <button
            type="button"
            className="chat-history-btn"
            onClick={onUndo}
            disabled={busy || restoring || !beatRef || !canUndo(history)}
            title={beatRef ? 'Undo the last AI edit to this beat' : 'Open a beat page in the editor to undo AI edits'}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="chat-history-btn"
            onClick={onRedo}
            disabled={busy || restoring || !beatRef || !canRedo(history)}
            title={beatRef ? 'Redo the last undone AI edit' : 'Open a beat page in the editor to redo AI edits'}
          >
            ↷ Redo
          </button>
          {restoreStatus && <span className="chat-history-status">{restoreStatus}</span>}
        </div>
        <div className="chat-input-row">
          <textarea
            rows={2}
            placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)"
            value={input}
            disabled={busy || restoring}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="primary" onClick={send} disabled={busy || restoring || !input.trim()}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
        <ConfirmDialog
          open={confirmClear}
          title="Clear conversation?"
          message="This hides the current conversation and starts fresh. It can't be undone here."
          confirmLabel="Clear"
          cancelLabel="Cancel"
          danger
          onConfirm={doClear}
          onCancel={() => setConfirmClear(false)}
        />
      </div>
    </div>
  );
}
