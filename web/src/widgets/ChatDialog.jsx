import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Modal } from './Modal.jsx';
import { apiPostJson, apiSseUrl } from '../api.js';
import { useLocation } from 'react-router-dom';
import { pageContextFromPath } from '../project/pageContext.js';

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

// AI chat dialog: each send POSTs /api/chat (which runs the shared agent
// loop against the browser's current project) and follows the run via SSE.
// Transcript state lives in the parent (Header) so closing/reopening the
// dialog keeps the conversation for the page session.
export function ChatDialog({ open, onClose, messages, setMessages }) {
  const location = useLocation();
  const pageCtx = useMemo(() => pageContextFromPath(location.pathname), [location.pathname]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const esRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

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

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setBusy(true);
    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'assistant', pending: true, progressLabel: 'sending…' },
    ]);
    try {
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
        // Server-emitted error events carry data; transport drops don't.
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

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <Modal open={open} title="AI chat" onClose={onClose} size="wide">
      <div className="chat-dialog">
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
          title="The agent is told which page you're on"
          aria-label={`Page context: ${pageCtx.label} — the agent is told which page you're on`}
        >
          Context: {pageCtx.label}
        </div>
        <div className="chat-input-row">
          <textarea
            rows={2}
            placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="primary" onClick={send} disabled={busy || !input.trim()}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
