// ProjectManagerDialog
//
// v1 scope: list + switch + create (rename/delete deferred). Opened from
// the Header brand and from the "project not found" screen. Switching
// navigates with a FULL page load (location.assign) so every Hocuspocus
// socket, EventSource, and poller from the old project is torn down.

import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson, projectHomeUrl } from '../api.js';

export function ProjectManagerDialog({ open, onClose, currentProjectId = null }) {
  const [projects, setProjects] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setTitle('');
    setProjects(null);
    (async () => {
      try {
        const data = await apiGet('/projects');
        if (!cancelled) setProjects(data?.projects || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  function switchTo(projectTitle) {
    location.assign(projectHomeUrl(projectTitle));
  }

  async function create(e) {
    e?.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await apiPostJson('/projects', { title: trimmed });
      switchTo(created.title);
      // No state reset — location.assign tears this page down.
    } catch (err) {
      // 409 duplicate / 400 invalid title surface here: api.js check()
      // extracts the JSON {error} body into err.message.
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Projects"
      onClose={onClose}
      footer={<button type="button" onClick={onClose}>Close</button>}
    >
      {error && <div className="error-banner">{error}</div>}

      {!projects && !error && (
        <p style={{ color: 'var(--fg-muted)' }}>Loading projects…</p>
      )}

      {projects && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {projects.map((p) => {
            const current = p.id === currentProjectId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => { if (!current) switchTo(p.title); }}
                  disabled={current}
                  style={{ width: '100%', textAlign: 'left' }}
                  title={current ? 'Current project' : `Switch to ${p.title}`}
                >
                  {p.title}
                  {current && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 8, fontSize: 12 }}>
                      current
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={create} style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New project title"
          maxLength={120}
          style={{ flex: 1 }}
        />
        <button type="submit" className="primary" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </form>
    </Modal>
  );
}
