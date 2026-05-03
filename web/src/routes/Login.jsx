import { useEffect, useRef, useState } from 'react';
import { requestApproval, pollStatus, saveSession } from '../auth/session.js';

const POLL_MS = 1000;

export function Login({ onAuthed }) {
  const [phase, setPhase] = useState('form'); // form | waiting | denied | error
  const [username, setUsername] = useState('');
  const [requestId, setRequestId] = useState(null);
  const [error, setError] = useState(null);
  const pollTimer = useRef(null);

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!username.trim()) return;
    try {
      const res = await requestApproval(username.trim());
      setRequestId(res.request_id);
      setPhase('waiting');
      poll(res.request_id);
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  async function poll(id) {
    try {
      const status = await pollStatus(id);
      if (status.status === 'approved') {
        saveSession({ session_id: status.session_id, username: status.username });
        onAuthed({ session_id: status.session_id, username: status.username });
        return;
      }
      if (status.status === 'denied') {
        setPhase('denied');
        return;
      }
      if (status.status === 'expired') {
        setError('Request expired before someone approved it.');
        setPhase('error');
        return;
      }
      pollTimer.current = setTimeout(() => poll(id), POLL_MS);
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  function reset() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setRequestId(null);
    setPhase('form');
    setError(null);
  }

  return (
    <div className="login-card">
      {phase === 'form' && (
        <form onSubmit={submit}>
          <h1>Screenplay Editor</h1>
          <p>Pick a name. Someone in the Discord channel needs to approve you.</p>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Your name"
            autoFocus
            maxLength={40}
          />
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={!username.trim()}>
              Request access
            </button>
          </div>
        </form>
      )}
      {phase === 'waiting' && (
        <div>
          <h1>Waiting…</h1>
          <p>
            Posted to Discord as <strong>{username}</strong>. Someone in the channel can
            click Approve or Deny.
          </p>
          <p style={{ color: 'var(--fg-muted)' }}>This can stay open. Polling…</p>
          <div className="actions">
            <button onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
      {phase === 'denied' && (
        <div>
          <h1>Denied</h1>
          <p>Someone in the channel denied this request.</p>
          <div className="actions">
            <button className="primary" onClick={reset}>Try again</button>
          </div>
        </div>
      )}
      {phase === 'error' && (
        <div>
          <h1>Error</h1>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
          <div className="actions">
            <button className="primary" onClick={reset}>Try again</button>
          </div>
        </div>
      )}
    </div>
  );
}
